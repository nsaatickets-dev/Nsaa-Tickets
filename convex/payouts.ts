import { action, mutation, internalAction, internalMutation, query } from "./_generated/server";
import { internal, api } from "./_generated/api";
import { v } from "convex/values";
import { requireAdmin, logAdminAction } from "./admin";
import { alertCritical } from "./alerts";
import { requireMoolreEnv } from "./moolreConfig";

// Moolre's TRANSFER channel codes are different from their COLLECTION
// channel codes (verified against docs.moolre.com) - MTN is 1 here vs 13
// for collections. Kept separate from orders.ts's detectMoolreChannel so
// the two mappings never get silently conflated.
export function detectMoolreTransferChannel(phone: string): string {
  const digits = phone.replace(/[\s\-()]/g, "");
  const local = digits.startsWith("233")
    ? `0${digits.slice(3)}`
    : digits.startsWith("+233")
      ? `0${digits.slice(4)}`
      : digits;
  const prefix = local.slice(0, 3);

  const mtn = ["024", "025", "053", "054", "055", "059"];
  const telecel = ["020", "030", "050"];
  const airtelTigo = ["026", "027", "028", "056", "057"];

  if (mtn.includes(prefix)) return "1";
  if (telecel.includes(prefix)) return "6";
  if (airtelTigo.includes(prefix)) return "7";

  throw new Error("Could not detect a mobile money network for this payout phone number.");
}

function isMoolreSuccess(value: unknown): boolean {
  return Number(value) === 1 || String(value ?? "").trim() === "1";
}

// How much of an event's ticket revenue is eligible for payout right now:
// paid orders' ticket subtotal only (the organizer's cut - the service
// fee is always retained by the platform and never appears here), minus
// anything already paid out or currently mid-transfer for this event.
export const eligiblePayoutAmount = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const paidOrders = await ctx.db
      .query("orders")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .filter((q) => q.eq(q.field("status"), "paid"))
      .collect();

    const grossGHS = paidOrders.reduce((sum, o) => sum + o.ticketSubtotalGHS, 0);

    const existingPayouts = await ctx.db
      .query("payouts")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .filter((q) => q.neq(q.field("status"), "failed"))
      .collect();

    const alreadyAccountedGHS = existingPayouts.reduce((sum, p) => sum + p.amountGHS, 0);

    return Math.max(0, Math.round((grossGHS - alreadyAccountedGHS) * 100) / 100);
  },
});

export const payoutsForEvent = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    return await ctx.db
      .query("payouts")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect();
  },
});

// Admin-triggered escrow release, per the product decision: revenue is
// eligible only after the event's end date has passed, and there is no
// self-serve organizer request flow or automatic batch job yet - this is
// invoked from the admin dashboard's Payouts tab (or the Convex dashboard
// function runner), one event at a time.
export const initiateOrganizerPayout = action({
  args: {
    eventId: v.id("events"),
    // Rare manual correction when the automatic eligibility math is known
    // to be wrong for this event (e.g. a prior off-platform settlement) -
    // logged explicitly so it's clearly not the computed figure.
    overrideAmountGHS: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { eventId, overrideAmountGHS },
  ): Promise<{ status: string; amountGHS?: number }> => {
    const admin = await requireAdmin(ctx);

    const event = await ctx.runQuery(api.events.getById, { eventId });
    if (!event) throw new Error("Event not found");
    if (event.status === "cancelled") {
      throw new Error("Event is cancelled - resolve refunds before paying out.");
    }
    if (!event.organizerPayoutPhone) {
      throw new Error("Event has no organizer payout phone on file.");
    }

    const cutoff = event.endsAt ?? event.startsAt;
    if (Date.now() < cutoff) {
      throw new Error("Event hasn't ended yet - revenue isn't eligible for payout until then.");
    }

    const eligibleGHS: number = await ctx.runQuery(api.payouts.eligiblePayoutAmount, { eventId });
    const amountGHS = overrideAmountGHS ?? eligibleGHS;
    if (amountGHS <= 0) {
      return { status: "nothing_due", amountGHS: 0 };
    }

    const payoutId = await ctx.runMutation(internal.payouts.createPendingPayout, {
      eventId,
      organizerPayoutPhone: event.organizerPayoutPhone,
      amountGHS,
    });

    await ctx.runMutation(internal.payouts.logPayoutInitiated, {
      payoutId,
      adminSubject: admin.subject,
      adminLabel: admin.label,
      eventId,
      amountGHS,
      wasOverride: overrideAmountGHS !== undefined,
      eligibleGHS,
    });

    // Same prefixing scheme as orders.ts - lets the shared webhook tell a
    // payout apart from a customer payment.
    const externalref = `payout:${payoutId}`;
    const channel = detectMoolreTransferChannel(event.organizerPayoutPhone);
    const config = requireMoolreEnv([
      "MOOLRE_API_BASE",
      "MOOLRE_API_USER",
      "MOOLRE_API_KEY",
      "MOOLRE_ACCOUNT_NUMBER",
    ]);

    const response = await fetch(`${config.MOOLRE_API_BASE}/open/transact/transfer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-USER": config.MOOLRE_API_USER,
        "X-API-KEY": config.MOOLRE_API_KEY,
      },
      body: JSON.stringify({
        type: 1,
        channel,
        currency: "GHS",
        amount: String(amountGHS),
        receiver: event.organizerPayoutPhone,
        externalref,
        accountnumber: config.MOOLRE_ACCOUNT_NUMBER,
      }),
    });

    const data = await response.json();
    const accepted = data.status === 1;

    if (!accepted) {
      await ctx.runMutation(internal.payouts.markPayoutFailed, { payoutId });
      throw new Error(data.message || "Payout could not be started.");
    }

    return { status: "initiated", amountGHS };
  },
});

export const createPendingPayout = internalMutation({
  args: {
    eventId: v.id("events"),
    organizerPayoutPhone: v.string(),
    amountGHS: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("payouts", {
      ...args,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

export const markPayoutFailed = internalMutation({
  args: { payoutId: v.id("payouts") },
  handler: async (ctx, { payoutId }) => {
    await ctx.db.patch(payoutId, { status: "failed" });
  },
});

export const logPayoutInitiated = internalMutation({
  args: {
    payoutId: v.id("payouts"),
    adminSubject: v.string(),
    adminLabel: v.string(),
    eventId: v.id("events"),
    amountGHS: v.number(),
    wasOverride: v.boolean(),
    eligibleGHS: v.number(),
  },
  handler: async (ctx, args) => {
    await logAdminAction(ctx, { subject: args.adminSubject, label: args.adminLabel }, {
      action: "payout.initiate",
      targetType: "payout",
      targetId: args.payoutId,
      details: {
        eventId: args.eventId,
        amountGHS: args.amountGHS,
        wasOverride: args.wasOverride,
        eligibleGHS: args.eligibleGHS,
      },
    });
  },
});

// Admin God Mode: manual override for out-of-band settlement (e.g. a
// bank transfer made outside Moolre because a transfer was rejected) -
// bypasses the normal pending->paid verification flow entirely, so it's
// audit-logged with a mandatory reason rather than just a status field.
export const adminSetPayoutStatus = mutation({
  args: {
    payoutId: v.id("payouts"),
    status: v.union(v.literal("paid"), v.literal("failed")),
    reason: v.string(),
  },
  handler: async (ctx, { payoutId, status, reason }) => {
    const admin = await requireAdmin(ctx);
    const trimmedReason = reason.trim();
    if (!trimmedReason) throw new Error("A reason is required.");

    const payout = await ctx.db.get(payoutId);
    if (!payout) throw new Error("Payout not found.");

    await ctx.db.patch(payoutId, {
      status,
      paidAt: status === "paid" ? Date.now() : payout.paidAt,
    });

    await logAdminAction(ctx, admin, {
      action: "payout.manualStatus",
      targetType: "payout",
      targetId: payoutId,
      reason: trimmedReason,
      details: { previousStatus: payout.status, newStatus: status },
    });
  },
});

// Called from convex/http.ts, mirroring convex/moolre.ts's
// verifyAndProcessPayment - the webhook is just a "check now" nudge, we
// never trust its body, we re-fetch the authoritative status from
// Moolre's own status endpoint before marking a payout paid.
export const verifyAndProcessPayout = internalAction({
  args: { externalref: v.string(), payoutId: v.id("payouts") },
  handler: async (ctx, { externalref, payoutId }) => {
    let txstatus: number | undefined;
    let transactionId: string | undefined;

    try {
      const config = requireMoolreEnv([
        "MOOLRE_API_BASE",
        "MOOLRE_API_USER",
        "MOOLRE_API_PUBKEY",
        "MOOLRE_ACCOUNT_NUMBER",
      ]);
      const response = await fetch(`${config.MOOLRE_API_BASE}/open/transact/status`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-USER": config.MOOLRE_API_USER,
          "X-API-PUBKEY": config.MOOLRE_API_PUBKEY,
        },
        body: JSON.stringify({
          type: 1,
          idtype: "1",
          id: externalref,
          accountnumber: config.MOOLRE_ACCOUNT_NUMBER,
        }),
      });
      const payload = await response.json();
      txstatus = payload?.data?.txstatus;
      transactionId = payload?.data?.transactionid;
    } catch (err) {
      // Real money left the platform (a transfer to an organizer) and we
      // can't confirm it went through - worth a human looking at
      // promptly, not just a routine failure.
      await alertCritical(
        "Moolre payout status check failed",
        `Could not verify payout status for payout ${payoutId} (externalref ${externalref}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    await ctx.runMutation(internal.payouts.applyVerifiedPayoutStatus, {
      payoutId,
      isSuccess: isMoolreSuccess(txstatus),
      transactionId,
    });
  },
});

export const applyVerifiedPayoutStatus = internalMutation({
  args: {
    payoutId: v.id("payouts"),
    isSuccess: v.boolean(),
    transactionId: v.optional(v.string()),
  },
  handler: async (ctx, { payoutId, isSuccess, transactionId }) => {
    // Not a confirmed success - Moolre's docs don't document failure-state
    // txstatus values for transfers either, so leave it pending rather
    // than guess. A stuck "pending" payout is a support/ops question, not
    // something to silently resolve.
    if (!isSuccess) return;

    const payout = await ctx.db.get(payoutId);
    if (!payout || payout.status !== "pending") return;

    await ctx.db.patch(payoutId, {
      status: "paid",
      moolreReference: transactionId,
      paidAt: Date.now(),
    });
  },
});
