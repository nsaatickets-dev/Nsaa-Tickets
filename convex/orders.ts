import { mutation, query, internalMutation, action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

// How long a reservation holds inventory before it's released back to
// availability. Long enough to comfortably approve a MoMo prompt,
// short enough that abandoned carts don't lock up tickets forever.
const RESERVATION_MS = 10 * 60 * 1000; // 10 minutes

// Nsaa's fee structure: 5% of ticket subtotal + a flat GHS 0.50.
// This mirrors a standard, defensible ticketing fee shape. Adjust once
// you've validated pricing with real organizers.
function computeServiceFee(ticketSubtotalGHS: number): number {
  const percentageFee = ticketSubtotalGHS * 0.05;
  const flatFee = 0.5;
  return Math.round((percentageFee + flatFee) * 100) / 100;
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
    buyerEmail: v.optional(v.string()),
    clerkUserId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    const ticketType = await ctx.db.get(args.ticketTypeId);
    if (!ticketType) throw new Error("Ticket type not found");

    const available =
      ticketType.quantityTotal -
      ticketType.quantitySold -
      ticketType.quantityReserved;

    if (args.quantity < 1) throw new Error("Quantity must be at least 1");
    if (available < args.quantity) {
      throw new Error(
        `Only ${available} ticket(s) left for ${ticketType.name}`,
      );
    }

    const ticketSubtotalGHS = ticketType.priceGHS * args.quantity;
    const serviceFeeGHS = computeServiceFee(ticketSubtotalGHS);
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
      buyerName: args.buyerName,
      buyerPhone: args.buyerPhone,
      buyerEmail: args.buyerEmail,
      clerkUserId: identity?.subject,
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
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }): Promise<{ status: string }> => {
    const order = await ctx.runQuery(internal.orders.getOrderInternal, {
      orderId,
    });
    if (!order) throw new Error("Order not found");
    if (order.status !== "reserved") {
      throw new Error(`Order is ${order.status}, cannot pay`);
    }

    // --- Moolre payment request ---
    // Replace MOOLRE_API_BASE / credentials with real sandbox values.
    // See: https://moolre.com developer docs for the exact payment
    // initiation endpoint and payload shape - confirm field names against
    // their current API reference before wiring this for real, since this
    // is written against the general shape of a MoMo collection request.
    const response = await fetch(`${process.env.MOOLRE_API_BASE}/v1/collect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.MOOLRE_API_KEY}`,
      },
      body: JSON.stringify({
        amount: order.totalGHS,
        currency: "GHS",
        phone: order.buyerPhone,
        reference: order._id,
        callback_url: `${process.env.CONVEX_SITE_URL}/moolre/webhook`,
        description: "Nsaa Tickets order",
      }),
    });

    const data = await response.json();

    await ctx.runMutation(internal.orders.recordMoolreReference, {
      orderId,
      moolreReference: data.reference ?? data.transactionId ?? "unknown",
      moolreStatus: data.status ?? "initiated",
    });

    return { status: data.status ?? "initiated" };
  },
});

export const getOrderInternal = query({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    return await ctx.db.get(orderId);
  },
});

export const recordMoolreReference = internalMutation({
  args: {
    orderId: v.id("orders"),
    moolreReference: v.string(),
    moolreStatus: v.string(),
  },
  handler: async (ctx, { orderId, moolreReference, moolreStatus }) => {
    await ctx.db.patch(orderId, { moolreReference, moolreStatus });
  },
});
