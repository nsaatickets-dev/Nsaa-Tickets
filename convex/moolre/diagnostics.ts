// Ops-only tooling for investigating Moolre account/transaction state
// directly - none of this runs automatically except reassertMoolreCallback
// (see convex/crons.ts). Every other export here is an internalAction,
// not reachable from the browser, invoked via:
//   npx convex run moolre/diagnostics:<name> '{...}' --prod
//
// - validatePayoutRecipient: calls Validate Name for a phone/channel,
//   to check why a payout is being rejected without spending a real
//   transfer attempt. Captures raw HTTP status/headers/body too, to rule
//   out a transport-level cause hiding behind what looks like a normal
//   200 application error.
// - checkTransactionStatus: looks up one transaction by Moolre's own
//   generated transaction ID (not an externalref), for reconciling a
//   specific payout/refund/order row against Moolre's ledger.
// - listTransactions: the account's own transaction history, to see
//   what Moolre actually recorded versus what our own tables show.
// - checkWalletStatus: wallet balance/config, to rule out "insufficient
//   balance" before assuming a rejection is a channel-provisioning issue.
// - updateCallbackUrl: corrects the account's registered webhook
//   callback via Moolre's Update Account endpoint. `callback` has no
//   default - this must never silently repoint the account somewhere
//   unintended. `api` defaults to true and `accountname` is re-read from
//   the account's current state if omitted (see client.ts's
//   updateAccountCallback - Moolre clears both fields, not just leaves
//   them unchanged, when they're left out of the request entirely).
// - reconcilePayoutFromLedger: one-off correction for a payout row the
//   now-fixed status "1" vs 1 bug marked "failed" despite Moolre's
//   ledger showing it was actually accepted. Refuses to touch a row
//   that isn't currently "failed", so it can't be misused to overwrite
//   a real terminal state.
import { internalAction, internalMutation } from "../_generated/server";
import { v } from "convex/values";
import { requireMoolreEnv } from "../moolreConfig";
import {
  validateName,
  checkStatus,
  getAccountStatus,
  listTransactions,
  updateAccountCallback,
  detectMoolreTransferChannel,
} from "./client";

export const validatePayoutRecipient = internalAction({
  args: { phone: v.string(), channel: v.optional(v.string()), sublistid: v.optional(v.string()) },
  handler: async (
    ctx,
    { phone, channel, sublistid },
  ): Promise<{
    channel: string;
    httpStatus: number;
    httpHeaders: Record<string, string>;
    rawBody: string;
    status: unknown;
    code: unknown;
    message: unknown;
    accountName: unknown;
  }> => {
    const config = requireMoolreEnv([
      "MOOLRE_API_BASE",
      "MOOLRE_API_USER",
      "MOOLRE_API_KEY",
      "MOOLRE_ACCOUNT_NUMBER",
    ]);
    const resolvedChannel = channel ?? detectMoolreTransferChannel(phone);
    if (!resolvedChannel) {
      throw new Error("Could not detect a mobile money network for this phone number - pass an explicit channel.");
    }

    const response = await fetch(`${config.MOOLRE_API_BASE}/open/transact/validate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-USER": config.MOOLRE_API_USER,
        "X-API-KEY": config.MOOLRE_API_KEY,
      },
      body: JSON.stringify({
        type: 1,
        receiver: phone,
        channel: resolvedChannel,
        currency: "GHS",
        accountnumber: config.MOOLRE_ACCOUNT_NUMBER,
        ...(sublistid ? { sublistid } : {}),
      }),
    });

    // Diagnostic - capture the raw HTTP status/headers/body verbatim,
    // separately from the parsed JSON's own `status` field, to rule out
    // a transport-level (proxy, gateway, rate-limit) cause hiding behind
    // what looked like a normal 200 application error.
    const rawBody = await response.text();
    let data: any = {};
    try {
      data = JSON.parse(rawBody);
    } catch {
      // leave data empty - rawBody still carries whatever was returned
    }
    const httpHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      httpHeaders[key] = value;
    });

    return {
      channel: resolvedChannel,
      httpStatus: response.status,
      httpHeaders,
      rawBody,
      status: data.status,
      code: data.code,
      message: data.message,
      accountName: data.data,
    };
  },
});

export const checkTransactionStatus = internalAction({
  args: { transactionId: v.string() },
  handler: async (ctx, { transactionId }): Promise<{ status: unknown; code: unknown; message: unknown; data: unknown }> => {
    const config = requireMoolreEnv([
      "MOOLRE_API_BASE",
      "MOOLRE_API_USER",
      "MOOLRE_API_PUBKEY",
      "MOOLRE_ACCOUNT_NUMBER",
    ]);
    const result = await checkStatus(config, { idtype: "2", id: transactionId });
    return { status: result.status, code: result.code, message: result.message, data: result.data };
  },
});

export const listTransactionsAction = internalAction({
  args: { status: v.optional(v.union(v.literal(0), v.literal(1), v.literal(2))), limit: v.optional(v.number()) },
  handler: async (ctx, { status, limit }): Promise<{ status: unknown; code: unknown; message: unknown; data: unknown }> => {
    const config = requireMoolreEnv([
      "MOOLRE_API_BASE",
      "MOOLRE_API_USER",
      "MOOLRE_API_KEY",
      "MOOLRE_ACCOUNT_NUMBER",
    ]);
    return await listTransactions(config, {
      startdate: "2026-07-01 00:00:00",
      enddate: "2026-12-31 23:59:59",
      limit: limit ?? 20,
      status,
    });
  },
});

export const checkWalletStatus = internalAction({
  args: {},
  handler: async (ctx): Promise<{ status: unknown; code: unknown; message: unknown; data: unknown }> => {
    const config = requireMoolreEnv([
      "MOOLRE_API_BASE",
      "MOOLRE_API_USER",
      "MOOLRE_API_KEY",
      "MOOLRE_ACCOUNT_NUMBER",
    ]);
    return await getAccountStatus(config);
  },
});

export const updateCallbackUrl = internalAction({
  args: { callback: v.string(), api: v.optional(v.boolean()), accountname: v.optional(v.string()) },
  handler: async (
    ctx,
    { callback, api, accountname },
  ): Promise<{ status: unknown; code: unknown; message: unknown; data: unknown }> => {
    const config = requireMoolreEnv([
      "MOOLRE_API_BASE",
      "MOOLRE_API_USER",
      "MOOLRE_API_KEY",
      "MOOLRE_ACCOUNT_NUMBER",
    ]);
    return await updateAccountCallback(config, { callback, api, accountname });
  },
});

// Self-healing safety net for this session's root incident: the account's
// webhook callback silently pointed at a dead dev deployment for an
// unknown period, and nothing noticed until payouts/orders started
// staying stuck "pending". Re-asserting the same correct value every day
// is a no-op when nothing's wrong, and fixes it automatically if a future
// dev-testing session (see the rebuild plan's Phase 2) forgets to point
// the callback back at prod afterward. `api: true` is passed explicitly -
// updateAccountCallback defaults it anyway, but this cron is exactly the
// kind of call that would silently disable API access account-wide, every
// single day, if that default were ever removed - so make it impossible
// to get wrong here even if the shared default changes.
export const reassertMoolreCallback = internalAction({
  args: {},
  handler: async (ctx): Promise<{ status: unknown; code: unknown; message: unknown }> => {
    const siteUrl = process.env.CONVEX_SITE_URL;
    if (!siteUrl) {
      throw new Error("CONVEX_SITE_URL is not set - cannot determine this deployment's own webhook URL.");
    }
    const config = requireMoolreEnv([
      "MOOLRE_API_BASE",
      "MOOLRE_API_USER",
      "MOOLRE_API_KEY",
      "MOOLRE_ACCOUNT_NUMBER",
    ]);
    const callback = `${siteUrl.replace(/\/+$/, "")}/moolre/webhook`;
    const result = await updateAccountCallback(config, { callback, api: true });
    return { status: result.status, code: result.code, message: result.message };
  },
});

// One-off ops fix - reconciles a payout row that attemptMoolreTransfer's
// now-fixed status === 1 vs "1" bug marked "failed" even though Moolre's
// own ledger shows it was actually accepted and is still pending. Only
// ever needed for rows created before that fix shipped; new rows can't
// hit this since setPayoutAcceptedChannel now runs correctly on accept.
export const reconcilePayoutFromLedger = internalMutation({
  args: {
    payoutId: v.id("payouts"),
    externalRef: v.string(),
    channel: v.string(),
    moolreReference: v.string(),
  },
  handler: async (ctx, { payoutId, externalRef, channel, moolreReference }) => {
    const payout = await ctx.db.get(payoutId);
    if (!payout) throw new Error("Payout not found.");
    if (payout.status !== "failed") {
      throw new Error(`Refusing to reconcile a payout that isn't currently "failed" (is "${payout.status}").`);
    }
    await ctx.db.patch(payoutId, { status: "pending", externalRef, channel, moolreReference });
  },
});
