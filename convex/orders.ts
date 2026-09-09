import { mutation, query, internalMutation, internalQuery, action, ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { computePlatformFee, feePercentForTier } from "./events";
import { optionalTrimmed, requireNonEmpty, requireValidEmail, requireValidGhanaPhone } from "./validation";
import { rateLimiter } from "./rateLimit";
import { requireMoolreEnv } from "./moolreConfig";
import { isBuyerBlocked } from "./buyerBlocklist";
import { createHostedCheckoutLink as requestHostedCheckoutLink } from "./moolre/client";

// How long a reservation holds inventory before it's released back to
// availability. Long enough to comfortably approve a MoMo prompt,
// short enough that abandoned carts don't lock up tickets forever.
const RESERVATION_MS = 10 * 60 * 1000; // 10 minutes

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
    // Set by checkout.html when it was reached via the WhatsApp bot's
    // checkout link (convex/whatsapp.ts:sendCheckoutLinkForReply), so the
    // paid-order pipeline knows to also push a WhatsApp confirmation - see
    // moolre.ts:applyVerifiedStatus. Optional/backward-compatible: every
    // existing web order simply omits it and stays source "web".
    waPhone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    const buyerName = requireNonEmpty(args.buyerName, "Full name", 120);
    const buyerPhone = requireValidGhanaPhone(args.buyerPhone);
    const buyerEmail = requireValidEmail(args.buyerEmail);
    const referralCode = optionalTrimmed(args.referralCode, 80);
    const waPhone = optionalTrimmed(args.waPhone, 32);

    if (await isBuyerBlocked(ctx, buyerPhone, buyerEmail)) {
      throw new Error("This account is not able to purchase tickets. Contact support.");
    }

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
    const serviceFeeGHS = computePlatformFee(ticketSubtotalGHS, feePercent);
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
      ...(waPhone ? { source: "whatsapp" as const, whatsappPhone: waPhone } : {}),
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

export const prepareInlineCheckout = action({
  args: {
    orderId: v.id("orders"),
    method: v.union(v.literal("momo"), v.literal("card")),
  },
  handler: async (
    ctx,
    { orderId, method },
  ): Promise<{
    publicKey: string;
    accountNumber: string;
    amount: number;
    currency: "GHS";
    externalRef: string;
    metadata: Record<string, string>;
  }> => {
    const order = await ctx.runQuery(internal.orders.getOrderInternal, {
      orderId,
    });
    if (!order) throw new Error("Order not found");
    if (order.status !== "reserved") {
      throw new Error(`Order is ${order.status}, cannot pay`);
    }

    const config = requireMoolreEnv([
      "MOOLRE_API_BASE",
      "MOOLRE_API_PUBKEY",
      "MOOLRE_ACCOUNT_NUMBER",
    ]);

    const externalRef = `order:${order._id}:${method}:inline:${Date.now()}`;

    await ctx.runMutation(internal.orders.recordMoolreReference, {
      orderId,
      moolreReference: "inline_checkout",
      moolreExternalRef: externalRef,
      moolreStatus: "initiated",
    });

    return {
      publicKey: config.MOOLRE_API_PUBKEY,
      accountNumber: config.MOOLRE_ACCOUNT_NUMBER,
      amount: Math.round(order.totalGHS * 100) / 100,
      currency: "GHS",
      externalRef,
      metadata: {
        order_id: order._id,
        payment_method: method,
        platform: "nsaa_tickets",
      },
    };
  },
});

async function createHostedCheckoutLink(
  ctx: ActionCtx,
  {
    orderId,
    returnUrl,
    method,
  }: {
    orderId: Id<"orders">;
    returnUrl?: string;
    method: "momo" | "card";
  },
): Promise<{ authorizationUrl: string }> {
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

    const externalref = `order:${order._id}:${method}:${Date.now()}`;
    const siteUrl = process.env.CONVEX_SITE_URL ?? "";
    const callback = siteUrl ? `${siteUrl.replace(/\/+$/, "")}/moolre/webhook` : undefined;

    const result = await requestHostedCheckoutLink(config, {
      amountGHS: order.totalGHS,
      externalref,
      callback,
      redirect: returnUrl,
    });

    const failureReason = result.accepted
      ? undefined
      : result.message || "Moolre checkout could not be started. Please try again.";

    await ctx.runMutation(internal.orders.recordMoolreReference, {
      orderId,
      moolreReference: result.accepted ? (result.data?.data?.reference ?? "unknown") : (result.data?.code ?? "unknown"),
      moolreExternalRef: externalref,
      moolreStatus: result.accepted ? "initiated" : "rejected",
      moolreFailureReason: failureReason,
    });

    if (!result.accepted) {
      throw new Error(failureReason!);
    }

    if (!result.authorizationUrl) {
      const reason = "Moolre did not return a checkout link.";
      await ctx.runMutation(internal.orders.recordMoolreReference, {
        orderId,
        moolreReference: result.data?.code ?? "unknown",
        moolreExternalRef: externalref,
        moolreStatus: "rejected",
        moolreFailureReason: reason,
      });
      throw new Error(reason);
    }

    return { authorizationUrl: result.authorizationUrl };
}

// Hosted Moolre checkout link (POST /embed/link). This is now used for
// both MoMo and card because Moolre's hosted page is the reliable buyer
// experience; the direct MoMo prompt path can silently fail to appear on
// some accounts/networks.
export const initiateHostedCheckout = action({
  args: {
    orderId: v.id("orders"),
    method: v.union(v.literal("momo"), v.literal("card")),
    returnUrl: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ authorizationUrl: string }> => {
    return await createHostedCheckoutLink(ctx, args);
  },
});

// Backward-compatible alias for older deployed checkout pages while
// Vercel rolls forward. New code calls initiateHostedCheckout directly.
export const initiateCardPayment = action({
  args: { orderId: v.id("orders"), returnUrl: v.optional(v.string()) },
  handler: async (ctx, { orderId, returnUrl }): Promise<{ authorizationUrl: string }> => {
    return await createHostedCheckoutLink(ctx, {
      orderId,
      returnUrl,
      method: "card",
    });
  },
});

export const refreshPaymentStatus = action({
  args: { orderId: v.id("orders") },
  handler: async (
    ctx,
    { orderId },
  ): Promise<{
    status: string;
    moolreStatus?: string;
    checkedAt: number;
  }> => {
    const order = await ctx.runQuery(internal.orders.getOrderInternal, { orderId });
    if (!order) throw new Error("Order not found");

    if (order.status !== "reserved") {
      return {
        status: order.status,
        moolreStatus: order.moolreStatus,
        checkedAt: Date.now(),
      };
    }

    if (!order.moolreExternalRef) {
      return {
        status: order.status,
        moolreStatus: order.moolreStatus ?? "not_started",
        checkedAt: Date.now(),
      };
    }

    await ctx.runAction(internal.moolre.webhook.verifyAndProcessPayment, {
      orderId,
      externalref: order.moolreExternalRef,
    });

    const updated = await ctx.runQuery(internal.orders.getOrderInternal, { orderId });
    return {
      status: updated?.status ?? order.status,
      moolreStatus: updated?.moolreStatus ?? order.moolreStatus,
      checkedAt: Date.now(),
    };
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

// Marks a WhatsApp-sourced order as reminded so the scheduled call and the
// cron safety-net sweep (convex/whatsapp.ts:sweepMissedEventReminders)
// can't both send the same reminder twice.
export const markReminderSent = internalMutation({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    await ctx.db.patch(orderId, { reminderSentAt: Date.now() });
  },
});

// Used by the reminder safety-net sweep to find WhatsApp-sourced paid
// orders for a given event that haven't had a reminder sent yet.
export const whatsappOrdersNeedingReminder = internalQuery({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const orders = await ctx.db
      .query("orders")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect();
    return orders.filter(
      (order) => order.status === "paid" && order.source === "whatsapp" && !order.reminderSentAt,
    );
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
