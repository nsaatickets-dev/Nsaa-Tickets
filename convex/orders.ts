import { mutation, query, internalMutation, internalQuery, action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { feePercentForTier } from "./events";
import { optionalTrimmed, requireNonEmpty, requireValidEmail, requireValidGhanaPhone } from "./validation";
import { rateLimiter } from "./rateLimit";
import { requireMoolreEnv } from "./moolreConfig";

// How long a reservation holds inventory before it's released back to
// availability. Long enough to comfortably approve a MoMo prompt,
// short enough that abandoned carts don't lock up tickets forever.
const RESERVATION_MS = 10 * 60 * 1000; // 10 minutes

// Nsaa's fee is a pure percentage of ticket subtotal, driven by the
// organizer's pricing tier (see convex/events.ts:TIER_FEE_PERCENT) - no
// flat add-on. Free tickets are never charged a fee, matching every
// tier's intent (a percentage of zero is zero, but this also protects
// against a future flat-fee re-add accidentally charging free tickets).
function computeServiceFee(ticketSubtotalGHS: number, feePercent: number): number {
  if (ticketSubtotalGHS <= 0) return 0;
  return Math.round(ticketSubtotalGHS * feePercent * 100) / 100;
}

// Moolre's collection API requires a `channel` telling it which network
// to route the Mobile Money prompt to (13=MTN, 6=Telecel, 7=AirtelTigo).
// We only collect a phone number at checkout, so the network is inferred
// from Ghana's published numbering-plan prefixes rather than asking the
// buyer to pick their own network. Coverage is best-effort - carrier
// number ranges have shifted with the AirtelTigo/Telecel rebrands, so
// confirm against real numbers on each network before live rollout.
// If Moolre routes to the wrong network the collection request itself
// fails (returned as an error code, not a silent misfire), so a wrong
// guess here surfaces as a retryable error, not a lost payment.
function detectMoolreChannel(phone: string): string {
  const digits = phone.replace(/[\s\-()]/g, "");
  const local = digits.startsWith("233")
    ? `0${digits.slice(3)}`
    : digits.startsWith("+233")
      ? `0${digits.slice(4)}`
      : digits;
  const prefix2 = local.slice(0, 3); // "0XX"

  const mtn = ["024", "025", "053", "054", "055", "059"];
  const telecel = ["020", "030", "050"];
  const airtelTigo = ["026", "027", "028", "056", "057"];

  if (mtn.includes(prefix2)) return "13";
  if (telecel.includes(prefix2)) return "6";
  if (airtelTigo.includes(prefix2)) return "7";

  throw new Error(
    "Could not detect a mobile money network for this number. Please contact support.",
  );
}

function resolveMoolreChannel(phone: string, explicitChannel?: string): string {
  if (explicitChannel) {
    const allowed = new Set(["13", "6", "7"]);
    if (!allowed.has(explicitChannel)) {
      throw new Error("Choose a valid Mobile Money network.");
    }
    return explicitChannel;
  }
  return detectMoolreChannel(phone);
}

function moolreAccepted(data: any): boolean {
  return Number(data?.status) === 1 || String(data?.status ?? "").trim() === "1";
}

async function readMoolreJson(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_err) {
    return {
      status: response.ok ? 1 : 0,
      code: response.status,
      message: text,
    };
  }
}

function moolreMessage(data: any, fallback: string): string {
  const message = String(data?.message ?? data?.msg ?? "").trim();
  return message || fallback;
}

// Step 1 of checkout: reserve inventory, create a pending order.
// This is what makes the reservation-with-timeout model work - the
// ticket count visibly drops the instant someone starts checkout, not
// only after payment confirms.
export const createReservation = mutation({
  args: {
    eventId: v.id("events"),
    ticketTypeId: v.id("ticketTypes"),
    quantity: v.number(),
    buyerName: v.string(),
    buyerPhone: v.string(),
    buyerEmail: v.string(),
    clerkUserId: v.optional(v.string()),
    referralCode: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    const buyerName = requireNonEmpty(args.buyerName, "Full name", 120);
    const buyerPhone = requireValidGhanaPhone(args.buyerPhone);
    const buyerEmail = requireValidEmail(args.buyerEmail);
    const referralCode = optionalTrimmed(args.referralCode, 80);

    await rateLimiter.limit(ctx, "reservationsGlobal", { throws: true });
    await rateLimiter.limit(ctx, "reservationsByPhone", { key: buyerPhone, throws: true });

    const ticketType = await ctx.db.get(args.ticketTypeId);
    if (!ticketType) throw new Error("Ticket type not found");
    const event = await ctx.db.get(args.eventId);
    if (!event) throw new Error("Event not found");

    const available =
      ticketType.quantityTotal -
      ticketType.quantitySold -
      ticketType.quantityReserved;

    if (!Number.isInteger(args.quantity) || args.quantity < 1 || args.quantity > 20) {
      throw new Error("Quantity must be a whole number between 1 and 20.");
    }
    if (available < args.quantity) {
      throw new Error(
        `Only ${available} ticket(s) left for ${ticketType.name}`,
      );
    }

    // Fee percentage is the organizer's own pricing tier, not a
    // platform-wide constant - see convex/events.ts:setOrganizerTier.
    const organizerProfile = event.organizerClerkUserId
      ? await ctx.db
          .query("organizerProfiles")
          .withIndex("by_organizer", (q) =>
            q.eq("organizerClerkUserId", event.organizerClerkUserId!),
          )
          .unique()
      : null;
    const feePercent = feePercentForTier(
      organizerProfile?.tier,
      organizerProfile?.customFeePercent,
    );

    const ticketSubtotalGHS = ticketType.priceGHS * args.quantity;
    const serviceFeeGHS = computeServiceFee(ticketSubtotalGHS, feePercent);
    const totalGHS =
      Math.round((ticketSubtotalGHS + serviceFeeGHS) * 100) / 100;

    // Reserve the inventory now, atomically, within this mutation.
    await ctx.db.patch(args.ticketTypeId, {
      quantityReserved: ticketType.quantityReserved + args.quantity,
    });

    const reservedUntil = Date.now() + RESERVATION_MS;

    const orderId = await ctx.db.insert("orders", {
      eventId: args.eventId,
      ticketTypeId: args.ticketTypeId,
      quantity: args.quantity,
      buyerName,
      buyerPhone,
      buyerEmail,
      clerkUserId: identity?.subject,
      referralCode,
      ticketSubtotalGHS,
      serviceFeeGHS,
      totalGHS,
      status: "reserved",
      reservedUntil,
      createdAt: Date.now(),
    });

    // Schedule this specific reservation's expiry sweep. Even though the
    // cron below does a periodic sweep too, scheduling an exact-time
    // check keeps inventory accurate without waiting for the next tick.
    await ctx.scheduler.runAt(
      reservedUntil,
      internal.orders.expireReservationIfUnpaid,
      { orderId },
    );

    return { orderId, totalGHS, reservedUntil };
  },
});

// Called by the scheduler (or the periodic cron sweep) once a
// reservation's hold window has passed. Only acts if the order is still
// "reserved" - if it already paid, this is a no-op.
export const expireReservationIfUnpaid = internalMutation({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    const order = await ctx.db.get(orderId);
    if (!order || order.status !== "reserved") return;

    const ticketType = await ctx.db.get(order.ticketTypeId);
    if (ticketType) {
      await ctx.db.patch(order.ticketTypeId, {
        quantityReserved: Math.max(
          0,
          ticketType.quantityReserved - order.quantity,
        ),
      });
    }

    await ctx.db.patch(orderId, { status: "expired" });
  },
});

// Periodic safety-net sweep in case a scheduled expiry was missed
// (e.g. a deploy happened at the wrong moment). Wired up in crons.ts.
export const sweepExpiredReservations = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const stale = await ctx.db
      .query("orders")
      .withIndex("by_reserved_until", (q) =>
        q.eq("status", "reserved").lt("reservedUntil", now),
      )
      .collect();

    for (const order of stale) {
      const ticketType = await ctx.db.get(order.ticketTypeId);
      if (ticketType) {
        await ctx.db.patch(order.ticketTypeId, {
          quantityReserved: Math.max(
            0,
            ticketType.quantityReserved - order.quantity,
          ),
        });
      }
      await ctx.db.patch(order._id, { status: "expired" });
    }
  },
});

export const getOrder = query({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    return await ctx.db.get(orderId);
  },
});

export const getOrderSummary = query({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    const order = await ctx.db.get(orderId);
    if (!order) return null;

    const event = await ctx.db.get(order.eventId);
    const ticketType = await ctx.db.get(order.ticketTypeId);

    return { order, event, ticketType };
  },
});

// Step 2 of checkout: kick off the actual Moolre payment request for an
// already-reserved order. Separated from createReservation so the UI
// can show "reserved, now confirm payment" as a distinct step.
export const initiateMoolrePayment = action({
  args: {
    orderId: v.id("orders"),
    otpcode: v.optional(v.string()),
    channel: v.optional(v.string()),
  },
  handler: async (ctx, { orderId, otpcode, channel }): Promise<{ status: string }> => {
    const order = await ctx.runQuery(internal.orders.getOrderInternal, {
      orderId,
    });
    if (!order) throw new Error("Order not found");
    if (order.status !== "reserved") {
      throw new Error(`Order is ${order.status}, cannot pay`);
    }

    const config = requireMoolreEnv([
      "MOOLRE_API_BASE",
      "MOOLRE_API_USER",
      "MOOLRE_API_KEY",
      "MOOLRE_ACCOUNT_NUMBER",
    ]);

    if (!otpcode && order.moolreStatus === "initiated") {
      return { status: "initiated" };
    }

    // --- Moolre payment request ---
    // Verified against docs.moolre.com (Initiate Payment): POST
    // /open/transact/payment, X-API-USER + X-API-KEY headers, externalref
    // must be unique per attempt so we use the order id (confirmed by
    // Moolre testing: resubmitting the same externalref with otpcode
    // does NOT hit the "must be unique" error - it's recognized as the
    // OTP retry for the same pending request). Moolre has no documented
    // per-request callback field - the webhook URL is registered once at
    // the account level (Moolre dashboard settings, or POST
    // /open/account/update with a `callback` field) pointing at
    // https://<your-deployment>.convex.site/moolre/webhook.
    const resolvedChannel = resolveMoolreChannel(order.buyerPhone, channel);
    // Prefixed so the shared webhook (convex/http.ts) can tell a customer
    // payment apart from an organizer payout - both land on the same
    // callback URL since Moolre registers one webhook per account, not
    // per transaction type.
    const externalref =
      (otpcode || order.moolreStatus === "otp_required" || order.moolreStatus === "otp_invalid") &&
      order.moolreExternalRef
        ? order.moolreExternalRef
        : `order:${order._id}:momo:${Date.now()}`;

    const response = await fetch(`${config.MOOLRE_API_BASE}/open/transact/payment`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-USER": config.MOOLRE_API_USER,
        "X-API-KEY": config.MOOLRE_API_KEY,
      },
      body: JSON.stringify({
        type: 1,
        channel: resolvedChannel,
        currency: "GHS",
        payer: order.buyerPhone,
        amount: String(order.totalGHS),
        externalref,
        accountnumber: config.MOOLRE_ACCOUNT_NUMBER,
        ...(otpcode ? { otpcode } : {}),
      }),
    });

    const data = await readMoolreJson(response);

    // TP14: confirmed via Moolre testing - Moolre texts a verification
    // code directly to the buyer's phone and won't process the collection
    // until we resubmit this same request with that code as `otpcode`.
    // Not every account/channel triggers this; treat it as optional.
    if (data.code === "TP14") {
      await ctx.runMutation(internal.orders.recordMoolreReference, {
        orderId,
        moolreReference: String(data.data ?? data.code ?? "otp_required"),
        moolreExternalRef: externalref,
        moolreStatus: "otp_required",
      });
      return { status: "otp_required" };
    }

    // TP15: wrong code, not a real failure - let the buyer retry entering
    // it rather than killing their reservation over a typo.
    if (data.code === "TP15") {
      await ctx.runMutation(internal.orders.recordMoolreReference, {
        orderId,
        moolreReference: String(data.code),
        moolreExternalRef: externalref,
        moolreStatus: "otp_invalid",
        moolreFailureReason: moolreMessage(data, "Incorrect verification code."),
      });
      return { status: "otp_invalid" };
    }

    const accepted = response.ok && moolreAccepted(data);
    const failureReason = accepted
      ? undefined
      : moolreMessage(data, "Payment could not be started. Please try again.");

    await ctx.runMutation(internal.orders.recordMoolreReference, {
      orderId,
      moolreReference:
        accepted && typeof data.data === "string" ? data.data : (data.code ?? "unknown"),
      moolreExternalRef: externalref,
      moolreStatus: accepted ? "initiated" : "rejected",
      moolreFailureReason: failureReason,
    });

    if (!accepted) {
      // Keep the reservation retryable until the hold naturally expires.
      // Rejections here can be recoverable: the buyer can choose the right
      // MoMo network, retry a transient processor error, or switch to card.
      throw new Error(failureReason!);
    }

    return { status: "initiated" };
  },
});

// Card payment alternative to the direct MoMo collection above. Moolre
// has no direct card-charge endpoint - this generates a one-time hosted
// checkout link (POST /embed/link) that the buyer is redirected to;
// Moolre handles card entry/PCI compliance on their own page, not us.
// Confirmation still flows through the same webhook + status-check path
// as MoMo (convex/moolre.ts:verifyAndProcessPayment) since it's the same
// underlying externalref/order:<id> convention - this is untested against
// a real card yet, confirm the confirmation path fires before
// relying on it for real payments.
export const initiateCardPayment = action({
  args: { orderId: v.id("orders"), returnUrl: v.optional(v.string()) },
  handler: async (ctx, { orderId, returnUrl }): Promise<{ authorizationUrl: string }> => {
    const order = await ctx.runQuery(internal.orders.getOrderInternal, {
      orderId,
    });
    if (!order) throw new Error("Order not found");
    if (order.status !== "reserved") {
      throw new Error(`Order is ${order.status}, cannot pay`);
    }

    const config = requireMoolreEnv([
      "MOOLRE_API_BASE",
      "MOOLRE_API_USER",
      "MOOLRE_API_PUBKEY",
      "MOOLRE_ACCOUNT_NUMBER",
    ]);

    const externalref = `order:${order._id}:card:${Date.now()}`;
    const siteUrl = process.env.CONVEX_SITE_URL ?? "";
    const callback = siteUrl ? `${siteUrl.replace(/\/+$/, "")}/moolre/webhook` : undefined;

    const response = await fetch(`${config.MOOLRE_API_BASE}/embed/link`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-USER": config.MOOLRE_API_USER,
        "X-API-PUBKEY": config.MOOLRE_API_PUBKEY,
      },
      body: JSON.stringify({
        type: 1,
        amount: String(order.totalGHS),
        // Moolre's own "business email" field for their hosted page, not
        // the buyer's - buyer email is optional in guest checkout so it
        // can't be relied on here.
        email: "tickets@nsaatickets.com",
        externalref,
        reusable: 0,
        currency: "GHS",
        accountnumber: config.MOOLRE_ACCOUNT_NUMBER,
        callback,
        redirect: returnUrl,
      }),
    });

    const data = await readMoolreJson(response);
    const accepted = response.ok && moolreAccepted(data);
    const failureReason = accepted
      ? undefined
      : moolreMessage(data, "Card payment could not be started. Please try again.");

    await ctx.runMutation(internal.orders.recordMoolreReference, {
      orderId,
      moolreReference: accepted ? (data.data?.reference ?? "unknown") : (data.code ?? "unknown"),
      moolreExternalRef: externalref,
      moolreStatus: accepted ? "initiated" : "rejected",
      moolreFailureReason: failureReason,
    });

    if (!accepted) {
      throw new Error(failureReason!);
    }

    const authorizationUrl = data.data?.authorization_url;
    if (!authorizationUrl) {
      const reason = "Moolre did not return a checkout link.";
      await ctx.runMutation(internal.orders.recordMoolreReference, {
        orderId,
        moolreReference: data.code ?? "unknown",
        moolreExternalRef: externalref,
        moolreStatus: "rejected",
        moolreFailureReason: reason,
      });
      throw new Error(reason);
    }

    return { authorizationUrl };
  },
});

export const getOrderInternal = internalQuery({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    return await ctx.db.get(orderId);
  },
});

export const recordMoolreReference = internalMutation({
  args: {
    orderId: v.id("orders"),
    moolreReference: v.string(),
    moolreExternalRef: v.optional(v.string()),
    moolreStatus: v.string(),
    moolreFailureReason: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { orderId, moolreReference, moolreExternalRef, moolreStatus, moolreFailureReason },
  ) => {
    await ctx.db.patch(orderId, {
      moolreReference,
      ...(moolreExternalRef ? { moolreExternalRef } : {}),
      moolreStatus,
      moolreFailureReason,
    });
  },
});

// Called when Moolre rejects a payment request outright at initiation
// (not a later webhook failure) - releases the held inventory immediately
// instead of leaving the buyer stuck waiting on a webhook that will never
// fire.
export const markInitiationFailed = internalMutation({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    const order = await ctx.db.get(orderId);
    if (!order || order.status !== "reserved") return;

    const ticketType = await ctx.db.get(order.ticketTypeId);
    if (ticketType) {
      await ctx.db.patch(order.ticketTypeId, {
        quantityReserved: Math.max(0, ticketType.quantityReserved - order.quantity),
      });
    }

    await ctx.db.patch(orderId, { status: "failed" });
  },
});
