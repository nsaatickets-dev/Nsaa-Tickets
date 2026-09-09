// Single home for every raw Moolre API call this codebase makes, their
// response parsing, and the channel knowledge needed to use them
// correctly. Nothing here touches the Convex database or scheduler -
// these are pure request/response helpers. The domain files (orders.ts,
// payouts.ts, ordersAdmin.ts, serviceFees.ts) own what happens with the
// result: which table gets written, which channels to try in what order,
// when to give up and alert.
//
// Moolre's headers aren't uniform across endpoints - mixing these up
// fails in confusing ways, so every function below is grouped by exactly
// which pair it needs:
//   /open/transact/transfer  -> X-API-USER + X-API-KEY   (private)
//   /open/transact/validate  -> X-API-USER + X-API-KEY   (accepts public too, we always send private)
//   /open/transact/status    -> X-API-USER + X-API-PUBKEY (NOT the private key)
//   /open/account/status     -> X-API-USER + X-API-KEY
//   /open/account/update     -> X-API-USER + X-API-KEY
//   /embed/link               -> X-API-USER + X-API-PUBKEY
//   /open/sms/send            -> X-API-VASKEY only, no X-API-USER
//
// This app never sends a Moolre "channel" code for collections - the
// hosted checkout link (createHostedCheckoutLink below) is Moolre's own
// page, and it handles Mobile Money network selection itself. A direct,
// channel-driven collection API call used to exist here but was dead
// code (no live frontend ever called it) and was removed rather than
// ported, along with its own MTN=13/Telecel=6/AT=7 channel numbering -
// only the TRANSFER numbering (MTN=1/Telecel=6/AT=7/Bank=2) survives.

export type MoolreConfig = Record<string, string>;

// Moolre's PHP backend is inconsistent about whether "status" comes back
// as the number 1 or the string "1" on success - their own docs show a
// successful transfer's example response as `"status": "1"` (a string).
// This is the one place that check happens; every caller goes through it.
// A previous bug (`data.status === 1`, a strict comparison against the
// number) silently misclassified real accepted transfers as failed -
// confirmed against Moolre's own transaction ledger, which showed a
// transfer as accepted/pending while our own database had it marked
// "failed" from this exact comparison.
export function isMoolreAccepted(status: unknown): boolean {
  return Number(status) === 1 || String(status ?? "").trim() === "1";
}

// Some Moolre error responses aren't valid JSON (a plain-text gateway
// error page, for instance) - fall back to a synthetic envelope built
// from the raw HTTP response rather than letting JSON.parse throw.
export async function readMoolreJson(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { status: response.ok ? 1 : 0, code: response.status, message: text };
  }
}

// Moolre's own docs show `message` as a plain string in most responses
// but as an array of lines for at least one (a successful transfer) -
// handle both rather than let one shape silently stringify to
// "[object Object]" or similar.
export function moolreMessage(data: any, fallback: string): string {
  const raw = data?.message ?? data?.msg;
  const message = Array.isArray(raw) ? raw.join(" ") : String(raw ?? "").trim();
  return message || fallback;
}

// Centralizes *reading* Moolre's externalref scheme - order:<id>:<method>:<ts>,
// payout:<id>:<channel>, refund:<orderId>:<ts>:<channel>, fee:<id> - only
// the first two colon-delimited segments are ever meaningful; anything
// after that is per-attempt bookkeeping the writer needs but the reader
// doesn't. Writing this format is deliberately NOT centralized here -
// each domain file constructs its own externalref inline, since the
// exact format is live in Moolre's system right now for in-flight and
// historical transactions and must never change shape.
export function parseExternalRef(externalref: string): { kind: string; id: string } | null {
  const [kind = "", id = ""] = externalref.split(":");
  if (!kind || !id) return null;
  return { kind, id };
}

// Transfer channel codes - MTN=1, Telecel=6, AT=7, Bank=2.
export const ALL_MOOLRE_TRANSFER_CHANNELS = ["1", "6", "7"] as const;

// Prefix-to-network mapping is inherently unreliable - carriers get
// allocated new prefix blocks over time, blocks get reassigned (028 is
// classified as AirtelTigo by some references, Expresso by others), and
// ported numbers keep their original prefix regardless of their current
// network. Returns undefined instead of throwing on an unrecognized
// prefix - this is only ever used to pick which channel to try FIRST,
// never as a hard gate, since transferChannelsToTry below tries every
// channel regardless of whether a guess was possible.
export function detectMoolreTransferChannel(phone: string): string | undefined {
  const digits = phone.replace(/[\s\-()]/g, "");
  const local = digits.startsWith("233")
    ? `0${digits.slice(3)}`
    : digits.startsWith("+233")
      ? `0${digits.slice(4)}`
      : digits;
  const prefix = local.slice(0, 3);

  const mtn = ["024", "025", "053", "054", "055", "059"];
  const telecel = ["020", "050"];
  const airtelTigo = ["026", "027", "056", "057"];

  if (mtn.includes(prefix)) return "1";
  if (telecel.includes(prefix)) return "6";
  if (airtelTigo.includes(prefix)) return "7";
  return undefined;
}

// Every channel to try for a transfer, prefix-guessed one first - a
// rejected attempt on one channel is a definitive, synchronous "not
// sent" (not a timeout/uncertain outcome - see Moolre's own Safe Retries
// guidance), so trying the remaining channels next is a legitimate new
// attempt, not an unsafe blind retry. A ported number, or one whose
// prefix isn't recognized at all, still gets every channel tried.
export function transferChannelsToTry(phone: string): string[] {
  const guessed = detectMoolreTransferChannel(phone);
  return guessed
    ? [guessed, ...ALL_MOOLRE_TRANSFER_CHANNELS.filter((c) => c !== guessed)]
    : [...ALL_MOOLRE_TRANSFER_CHANNELS];
}

// POST /open/transact/status - the one status-check shape used by every
// domain (order payments, organizer payouts, refunds, service fees) and
// by the reconciliation diagnostics. idtype "1" looks up by the
// externalref we sent; "2" looks up by Moolre's own generated
// transaction ID. Never trust a webhook body's own status field - always
// re-fetch it from here first (see convex/http.ts).
export async function checkStatus(
  config: MoolreConfig,
  params: { idtype: "1" | "2"; id: string },
): Promise<{
  status: unknown;
  code: unknown;
  message: unknown;
  txstatus?: number;
  transactionId?: string;
  data: unknown;
}> {
  const response = await fetch(`${config.MOOLRE_API_BASE}/open/transact/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-USER": config.MOOLRE_API_USER,
      "X-API-PUBKEY": config.MOOLRE_API_PUBKEY,
    },
    body: JSON.stringify({
      type: 1,
      idtype: params.idtype,
      id: params.id,
      accountnumber: config.MOOLRE_ACCOUNT_NUMBER,
    }),
  });
  const data = await response.json();
  return {
    status: data.status,
    code: data.code,
    message: data.message,
    txstatus: data?.data?.txstatus,
    transactionId: data?.data?.transactionid,
    data: data.data,
  };
}

// POST /open/transact/transfer - sends money to a Mobile Money or bank
// account. sublistid is required by Moolre when channel is "2" (bank) -
// not documented on Validate Name's own params page, but present in
// Moolre's Agency Banking guide's real examples for both validate and
// transfer.
//
// `walletid` is NOT part of Moolre's documented request schema for this
// endpoint (confirmed against both their docs site and the full Postman
// collection), but this account's transfers fail synchronously with
// `TN02 "Invalid Account Details" data:"walletid"` without it - found by
// testing with the wallet number shown on this account's dashboard
// (Wallets page: "Nsaa Tickets - 72829"). Always sent; MOOLRE_WALLET_ID
// must be in the caller's requireMoolreEnv list.
export async function requestTransfer(
  config: MoolreConfig,
  params: {
    channel: string;
    amountGHS: number;
    receiver: string;
    externalref: string;
    sublistid?: string;
    reference?: string;
  },
): Promise<{ accepted: boolean; message: string | undefined; data: any }> {
  const response = await fetch(`${config.MOOLRE_API_BASE}/open/transact/transfer`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-USER": config.MOOLRE_API_USER,
      "X-API-KEY": config.MOOLRE_API_KEY,
    },
    body: JSON.stringify({
      type: 1,
      channel: params.channel,
      currency: "GHS",
      amount: String(params.amountGHS),
      receiver: params.receiver,
      externalref: params.externalref,
      accountnumber: config.MOOLRE_ACCOUNT_NUMBER,
      walletid: config.MOOLRE_WALLET_ID,
      ...(params.sublistid ? { sublistid: params.sublistid } : {}),
      ...(params.reference ? { reference: params.reference } : {}),
    }),
  });
  const data = await readMoolreJson(response);
  return { accepted: response.ok && isMoolreAccepted(data.status), message: data.message, data };
}

// POST /open/transact/validate - Moolre's own docs recommend calling
// this before a transfer to confirm the recipient's registered name.
// Only their documented AVD02 response means "genuinely not found" -
// anything else (including the undocumented AVD03 seen during this
// account's MTN/AT/bank outage) should be treated as "couldn't verify",
// never as proof the number is invalid.
export async function validateName(
  config: MoolreConfig,
  params: { channel: string; receiver: string; sublistid?: string },
): Promise<{ status: unknown; code: unknown; message: unknown; name: unknown }> {
  const response = await fetch(`${config.MOOLRE_API_BASE}/open/transact/validate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-USER": config.MOOLRE_API_USER,
      "X-API-KEY": config.MOOLRE_API_KEY,
    },
    body: JSON.stringify({
      type: 1,
      receiver: params.receiver,
      channel: params.channel,
      currency: "GHS",
      accountnumber: config.MOOLRE_ACCOUNT_NUMBER,
      ...(params.sublistid ? { sublistid: params.sublistid } : {}),
    }),
  });
  const data = await response.json();
  return { status: data.status, code: data.code, message: data.message, name: data.data };
}

// POST /embed/link - Moolre's hosted checkout page, used for both MoMo
// and card since the direct MoMo-prompt collection path could silently
// fail to appear on some accounts/networks (that direct path has been
// removed from this codebase entirely).
export async function createHostedCheckoutLink(
  config: MoolreConfig,
  params: { amountGHS: number; externalref: string; callback?: string; redirect?: string },
): Promise<{ accepted: boolean; message: string | undefined; authorizationUrl?: string; data: any }> {
  const response = await fetch(`${config.MOOLRE_API_BASE}/embed/link`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-USER": config.MOOLRE_API_USER,
      "X-API-PUBKEY": config.MOOLRE_API_PUBKEY,
    },
    body: JSON.stringify({
      type: 1,
      amount: String(params.amountGHS),
      // Moolre's own "business email" field for their hosted page, not
      // the buyer's - buyer email is optional in guest checkout so it
      // can't be relied on here.
      email: "tickets@nsaatickets.com",
      externalref: params.externalref,
      reusable: 0,
      currency: "GHS",
      accountnumber: config.MOOLRE_ACCOUNT_NUMBER,
      callback: params.callback,
      redirect: params.redirect,
    }),
  });
  const data = await readMoolreJson(response);
  const accepted = response.ok && isMoolreAccepted(data.status);
  return { accepted, message: data.message, authorizationUrl: data.data?.authorization_url, data };
}

// POST /open/sms/send - senderid must already be registered and approved
// in the Moolre dashboard before sends succeed (code ASMS07 = unapproved
// sender). Fire-and-forget from callers' perspective - an SMS failure
// must never block ticket delivery.
export async function sendSms(
  config: MoolreConfig,
  params: { senderid: string; recipient: string; message: string },
): Promise<void> {
  await fetch(`${config.MOOLRE_API_BASE}/open/sms/send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-VASKEY": config.MOOLRE_VASKEY,
    },
    body: JSON.stringify({
      type: 1,
      senderid: params.senderid,
      messages: [{ recipient: params.recipient, message: params.message }],
    }),
  });
}

// POST /open/account/status (type 1) - wallet balance/config. Used to
// rule out "insufficient balance" before assuming a transfer rejection
// is a channel-provisioning issue.
export async function getAccountStatus(
  config: MoolreConfig,
): Promise<{ status: unknown; code: unknown; message: unknown; data: unknown }> {
  const response = await fetch(`${config.MOOLRE_API_BASE}/open/account/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-USER": config.MOOLRE_API_USER,
      "X-API-KEY": config.MOOLRE_API_KEY,
    },
    body: JSON.stringify({ type: 1, accountnumber: config.MOOLRE_ACCOUNT_NUMBER }),
  });
  return await response.json();
}

// POST /open/account/status (type 2) - the account's transaction ledger,
// for reconciling our own records against what Moolre actually recorded.
export async function listTransactions(
  config: MoolreConfig,
  params: { startdate: string; enddate: string; limit: number; status?: 0 | 1 | 2 },
): Promise<{ status: unknown; code: unknown; message: unknown; data: unknown }> {
  const response = await fetch(`${config.MOOLRE_API_BASE}/open/account/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-USER": config.MOOLRE_API_USER,
      "X-API-KEY": config.MOOLRE_API_KEY,
    },
    body: JSON.stringify({
      type: 2,
      accountnumber: config.MOOLRE_ACCOUNT_NUMBER,
      startdate: params.startdate,
      enddate: params.enddate,
      limit: params.limit,
      ...(params.status !== undefined ? { status: params.status } : {}),
    }),
  });
  return await response.json();
}

// POST /open/account/update - Moolre's account API does NOT "leave
// unchanged" a field just because it's absent from the request, despite
// what the docs imply. Confirmed the hard way, in production: omitting
// `api` disables API access account-wide, and separately, omitting
// `accountname` wipes it to an empty string. Rather than track every
// field this turns out to affect one at a time, read the account's
// current state first and resend everything explicitly unless the
// caller overrides it - nothing this endpoint knows about can be
// silently cleared by an update call again.
export async function updateAccountCallback(
  config: MoolreConfig,
  params: { callback: string; api?: boolean; accountname?: string },
): Promise<{ status: unknown; code: unknown; message: unknown; data: unknown }> {
  let resolvedAccountname = params.accountname;
  if (resolvedAccountname === undefined) {
    const current = await getAccountStatus(config);
    const currentData = current.data as { accountname?: unknown } | undefined;
    if (typeof currentData?.accountname === "string" && currentData.accountname !== "") {
      resolvedAccountname = currentData.accountname;
    }
  }
  const response = await fetch(`${config.MOOLRE_API_BASE}/open/account/update`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-USER": config.MOOLRE_API_USER,
      "X-API-KEY": config.MOOLRE_API_KEY,
    },
    body: JSON.stringify({
      type: 1,
      accountnumber: config.MOOLRE_ACCOUNT_NUMBER,
      currency: "GHS",
      callback: params.callback,
      api: params.api ?? true,
      ...(resolvedAccountname !== undefined ? { accountname: resolvedAccountname } : {}),
    }),
  });
  return await response.json();
}
