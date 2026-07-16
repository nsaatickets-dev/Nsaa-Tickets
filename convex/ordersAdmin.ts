// Admin God Mode overrides for individual orders. Every mutation here is
// the deliberate, audited exception to the normal buyer-facing rules (an
// order only ever moves reserved -> paid via a real Moolre webhook, and
// "all sales final except full event cancellation" - see schema.ts) - not
// a general-purpose replacement for either.
import { mutation, action, internalMutation, internalQuery, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { requireAdmin, logAdminAction } from "./admin";
import { issueTickets } from "./tickets";
import { detectMoolreTransferChannel } from "./payouts";
import { requireMoolreEnv } from "./moolreConfig";
import { alertCritical } from "./alerts";

function isMoolreSuccess(value: unknown): boolean {
  return Number(value) === 1 || String(value ?? "").trim() === "1";
}

// For the "Moolre webhook never fired but the buyer really did pay" case -
// support confirms the Mobile Money debit happened (e.g. from the buyer's
// own MoMo statement) but Moolre's callback was missed and the 10-minute
// reservation already timed out or is about to. Issues real tickets and
// sends the same confirmation email/SMS a normal payment would.
export const adminForceMarkOrderPaid = mutation({
  args: { orderId: v.id("orders"), reason: v.string() },
  handler: async (ctx, { orderId, reason }) => {
    const admin = await requireAdmin(ctx);
    const trimmedReason = reason.trim();
    if (!trimmedReason) throw new Error("A reason is required.");

    const order = await ctx.db.get(orderId);
    if (!order) throw new Error("Order not found.");
    if (order.status !== "reserved") {
      throw new Error(`Order is ${order.status}, not reserved - nothing to force.`);
    }

    await ctx.db.patch(orderId, {
      status: "paid",
      moolreStatus: "admin_forced",
      paidAt: Date.now(),
    });

    await issueTickets(ctx, orderId);

    await ctx.scheduler.runAfter(0, internal.moolre.sendConfirmation, { orderId });
    await ctx.scheduler.runAfter(0, internal.moolre.sendOrganizerNotification, { orderId });

    await logAdminAction(ctx, admin, {
      action: "order.forcePaid",
      targetType: "order",
      targetId: orderId,
      reason: trimmedReason,
      details: { totalGHS: order.totalGHS },
    });
  },
});

// For a reservation that's clearly dead (buyer confirms they backed out,
// or a stuck "reserved" row support wants cleared immediately rather than
// waiting for the timeout sweep) - releases the held inventory right away.
export const adminForceExpireOrder = mutation({
  args: { orderId: v.id("orders"), reason: v.string() },
  handler: async (ctx, { orderId, reason }) => {
    const admin = await requireAdmin(ctx);
    const trimmedReason = reason.trim();
    if (!trimmedReason) throw new Error("A reason is required.");

    const order = await ctx.db.get(orderId);
    if (!order) throw new Error("Order not found.");
    if (order.status !== "reserved") {
      throw new Error(`Order is ${order.status}, not reserved - nothing to expire.`);
    }

    const ticketType = await ctx.db.get(order.ticketTypeId);
    if (ticketType) {
      await ctx.db.patch(order.ticketTypeId, {
        quantityReserved: Math.max(0, ticketType.quantityReserved - order.quantity),
      });
    }

    await ctx.db.patch(orderId, { status: "expired" });

    await logAdminAction(ctx, admin, {
      action: "order.forceExpire",
      targetType: "order",
      targetId: orderId,
      reason: trimmedReason,
    });
  },
});

// The deliberate, audited exception to "all sales final except full event
// cancellation" (schema.ts, README "Deliberate product decisions"). Moves
// real money via the same Moolre transfer mechanism payouts.ts uses for
// organizer payouts, just targeting the buyer's phone instead - and holds
// off flipping the order to "refunded" until that transfer is actually
// confirmed (see verifyAndProcessRefund below), the same rigor payouts
// already apply to organizer transfers.
export const adminRefundOrder = action({
  args: { orderId: v.id("orders"), amountGHS: v.number(), reason: v.string() },
  handler: async (ctx, { orderId, amountGHS, reason }): Promise<{ status: string }> => {
    const admin = await requireAdmin(ctx);
    const trimmedReason = reason.trim();
    if (!trimmedReason) throw new Error("A reason is required.");

    const order = await ctx.runQuery(internal.ordersAdmin.getOrderForRefund, { orderId });
    if (!order) throw new Error("Order not found.");
    if (order.status !== "paid") {
      throw new Error(`Order is ${order.status}, not paid - nothing to refund.`);
    }
    if (order.refundStatus === "pending") {
      throw new Error("A refund is already in progress for this order.");
    }
    if (!Number.isFinite(amountGHS) || amountGHS <= 0 || amountGHS > order.totalGHS) {
      throw new Error(`Refund amount must be between 0 and ${order.totalGHS} GHS.`);
    }

    const externalref = `refund:${orderId}:${Date.now()}`;
    const channel = detectMoolreTransferChannel(order.buyerPhone);
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
        receiver: order.buyerPhone,
        externalref,
        accountnumber: config.MOOLRE_ACCOUNT_NUMBER,
      }),
    });

    const data = await response.json();
    const accepted = data.status === 1;

    if (!accepted) {
      throw new Error(data.message || "Refund transfer could not be started.");
    }

    await ctx.runMutation(internal.ordersAdmin.markRefundPending, {
      orderId,
      amountGHS,
      reason: trimmedReason,
      externalref,
      adminSubject: admin.subject,
      adminLabel: admin.label,
    });

    return { status: "initiated" };
  },
});

export const getOrderForRefund = internalQuery({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    return await ctx.db.get(orderId);
  },
});

export const markRefundPending = internalMutation({
  args: {
    orderId: v.id("orders"),
    amountGHS: v.number(),
    reason: v.string(),
    externalref: v.string(),
    adminSubject: v.string(),
    adminLabel: v.string(),
  },
  handler: async (ctx, { orderId, amountGHS, reason, externalref, adminSubject, adminLabel }) => {
    await ctx.db.patch(orderId, {
      refundStatus: "pending",
      refundAmountGHS: amountGHS,
      refundReason: reason,
      refundExternalRef: externalref,
      refundInitiatedByAdminId: adminSubject,
    });

    await logAdminAction(ctx, { subject: adminSubject, label: adminLabel }, {
      action: "order.refundInitiated",
      targetType: "order",
      targetId: orderId,
      reason,
      details: { amountGHS, externalref },
    });
  },
});

// Called from convex/http.ts's shared Moolre webhook route once it sees a
// `refund:<orderId>:<ts>` externalref - re-verifies via Moolre's own status
// endpoint rather than trusting the webhook body, exactly like
// moolre.ts:verifyAndProcessPayment and payouts.ts:verifyAndProcessPayout.
export const verifyAndProcessRefund = internalAction({
  args: { externalref: v.string(), orderId: v.id("orders") },
  handler: async (ctx, { externalref, orderId }) => {
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
      // Real money left the platform back to a buyer and we can't confirm
      // it went through - same class of problem as a failed payout-status
      // check, worth a human looking at promptly.
      await alertCritical(
        "Moolre refund status check failed",
        `Could not verify refund status for order ${orderId} (externalref ${externalref}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    await ctx.runMutation(internal.ordersAdmin.applyVerifiedRefund, {
      orderId,
      isSuccess: isMoolreSuccess(txstatus),
      transactionId,
    });
  },
});

export const applyVerifiedRefund = internalMutation({
  args: {
    orderId: v.id("orders"),
    isSuccess: v.boolean(),
    transactionId: v.optional(v.string()),
  },
  handler: async (ctx, { orderId, isSuccess, transactionId }) => {
    // Not a confirmed success - leave it "pending" rather than guess, same
    // as payouts.ts's applyVerifiedPayoutStatus. A stuck pending refund is
    // a support question, not something to silently resolve either way.
    if (!isSuccess) return;

    const order = await ctx.db.get(orderId);
    if (!order || order.refundStatus !== "pending") return;

    await ctx.db.patch(orderId, {
      status: "refunded",
      refundStatus: "paid",
      refundMoolreReference: transactionId,
      refundedAt: Date.now(),
    });

    const tickets = await ctx.db
      .query("tickets")
      .withIndex("by_order", (q) => q.eq("orderId", orderId))
      .collect();
    for (const ticket of tickets) {
      if (ticket.status === "valid" || ticket.status === "pending") {
        await ctx.db.patch(ticket._id, { status: "void" });
      }
    }
  },
});
