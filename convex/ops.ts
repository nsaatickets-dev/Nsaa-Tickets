import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { requireAdmin, logAdminAction } from "./admin";
import { optionalTrimmed, requireNonEmpty, requireValidGhanaPhone } from "./validation";

const DAY_MS = 24 * 60 * 60 * 1000;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// Platform revenue by time window. Only orders with paidAt set represent
// money that actually moved through Moolre - the service fee is
// non-refundable (schema.ts) and stays with the platform even if the
// order later flips to "refunded" after an event cancellation, so paidAt
// (not current status) is what determines whether an order counts here.
export const revenueSummary = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);

    const paidOrders = (await ctx.db.query("orders").collect()).filter(
      (order) => order.paidAt !== undefined,
    );

    function sumSince(cutoff: number | null) {
      const relevant =
        cutoff === null ? paidOrders : paidOrders.filter((o) => (o.paidAt ?? 0) >= cutoff);
      return {
        orders: relevant.length,
        ticketSubtotalGHS: round2(relevant.reduce((sum, o) => sum + o.ticketSubtotalGHS, 0)),
        serviceFeeGHS: round2(relevant.reduce((sum, o) => sum + o.serviceFeeGHS, 0)),
        totalGHS: round2(relevant.reduce((sum, o) => sum + o.totalGHS, 0)),
      };
    }

    const now = Date.now();
    return {
      today: sumSince(now - DAY_MS),
      last7Days: sumSince(now - 7 * DAY_MS),
      last30Days: sumSince(now - 30 * DAY_MS),
      allTime: sumSince(null),
    };
  },
});

// Small "at a glance" numbers for the Overview tab that don't fit neatly
// into revenueSummary (which is paid-orders-only) or overview (which is
// entity lists, not counts).
export const opsStats = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);

    const reservedOrders = await ctx.db
      .query("orders")
      .withIndex("by_reserved_until", (q) => q.eq("status", "reserved"))
      .collect();

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const scanLogsToday = await ctx.db
      .query("scanLogs")
      .filter((q) => q.gte(q.field("createdAt"), startOfDay.getTime()))
      .collect();

    return {
      reservedCount: reservedOrders.length,
      scansToday: scanLogsToday.length,
      acceptedScansToday: scanLogsToday.filter((log) => log.outcome === "accepted").length,
    };
  },
});

export const overview = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);

    const [organizerInquiries, contactMessages, events, payouts, serviceFeeTransfers] = await Promise.all([
      ctx.db.query("organizerInquiries").collect(),
      ctx.db.query("contactMessages").collect(),
      ctx.db.query("events").collect(),
      ctx.db.query("payouts").collect(),
      ctx.db.query("serviceFeeTransfers").collect(),
    ]);

    return {
      organizerInquiries: organizerInquiries.sort((a, b) => b.createdAt - a.createdAt).slice(0, 80),
      contactMessages: contactMessages.sort((a, b) => b.createdAt - a.createdAt).slice(0, 80),
      events: events.sort((a, b) => b.createdAt - a.createdAt).slice(0, 120),
      payouts: payouts.sort((a, b) => b.createdAt - a.createdAt).slice(0, 120),
      serviceFeeTransfers: serviceFeeTransfers.sort((a, b) => b.createdAt - a.createdAt).slice(0, 120),
    };
  },
});

export const setOrganizerInquiryStatus = mutation({
  args: {
    inquiryId: v.id("organizerInquiries"),
    status: v.union(v.literal("new"), v.literal("contacted"), v.literal("closed")),
  },
  handler: async (ctx, { inquiryId, status }) => {
    await requireAdmin(ctx);
    await ctx.db.patch(inquiryId, { status });
  },
});

export const setContactMessageStatus = mutation({
  args: {
    messageId: v.id("contactMessages"),
    status: v.union(v.literal("new"), v.literal("contacted"), v.literal("closed")),
  },
  handler: async (ctx, { messageId, status }) => {
    await requireAdmin(ctx);
    await ctx.db.patch(messageId, { status });
  },
});

export const setEventStatusAdmin = mutation({
  args: {
    eventId: v.id("events"),
    status: v.union(v.literal("draft"), v.literal("published")),
  },
  handler: async (ctx, { eventId, status }) => {
    const admin = await requireAdmin(ctx);
    const event = await ctx.db.get(eventId);
    if (!event) throw new Error("Event not found.");
    await ctx.db.patch(eventId, { status });
    await ctx.scheduler.runAt(
      Math.max(Date.now(), event.endsAt ?? event.startsAt),
      internal.payouts.autoPayoutSingleEvent,
      { eventId },
    );
    await logAdminAction(ctx, admin, {
      action: "event.setStatus",
      targetType: "event",
      targetId: eventId,
      details: { status },
    });
  },
});

// Targeted corrections for support cases (a typo in the venue name, a
// wrong payout phone, handing an event to a different organizer account) -
// deliberately not a full event-editor replacement. No hard delete: that
// would break the orders/tickets/payouts audit trail permanently, so
// cancellation (below) is the only sanctioned destructive path.
export const adminUpdateEventFields = mutation({
  args: {
    eventId: v.id("events"),
    reason: v.string(),
    title: v.optional(v.string()),
    venue: v.optional(v.string()),
    address: v.optional(v.string()),
    city: v.optional(v.string()),
    startsAt: v.optional(v.number()),
    endsAt: v.optional(v.number()),
    organizerPayoutPhone: v.optional(v.string()),
    organizerClerkUserId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    const trimmedReason = args.reason.trim();
    if (!trimmedReason) throw new Error("A reason is required.");

    const event = await ctx.db.get(args.eventId);
    if (!event) throw new Error("Event not found.");

    const patch: Record<string, unknown> = {};
    if (args.title !== undefined) patch.title = requireNonEmpty(args.title, "Title", 160);
    if (args.venue !== undefined) patch.venue = requireNonEmpty(args.venue, "Venue", 160);
    if (args.address !== undefined) patch.address = requireNonEmpty(args.address, "Address", 240);
    if (args.city !== undefined) patch.city = requireNonEmpty(args.city, "City", 80);
    if (args.startsAt !== undefined) patch.startsAt = args.startsAt;
    if (args.endsAt !== undefined) patch.endsAt = args.endsAt;
    const effectiveStartsAt = (patch.startsAt as number | undefined) ?? event.startsAt;
    const effectiveEndsAt = (patch.endsAt as number | undefined) ?? event.endsAt;
    if (effectiveEndsAt !== undefined && effectiveEndsAt <= effectiveStartsAt) {
      throw new Error("End time must be after the start time.");
    }
    if (args.organizerPayoutPhone !== undefined) {
      patch.organizerPayoutPhone = requireValidGhanaPhone(args.organizerPayoutPhone);
    }
    if (args.organizerClerkUserId !== undefined) {
      patch.organizerClerkUserId = optionalTrimmed(args.organizerClerkUserId, 80);
    }

    if (Object.keys(patch).length === 0) {
      throw new Error("No fields to update.");
    }

    await ctx.db.patch(args.eventId, patch);
    await ctx.scheduler.runAt(
      Math.max(Date.now(), effectiveEndsAt ?? effectiveStartsAt),
      internal.payouts.autoPayoutSingleEvent,
      { eventId: args.eventId },
    );

    await logAdminAction(ctx, admin, {
      action: "event.updateFields",
      targetType: "event",
      targetId: args.eventId,
      reason: trimmedReason,
      details: patch,
    });
  },
});

export const cancelEventAndMarkRefunded = mutation({
  args: {
    eventId: v.id("events"),
    reason: v.string(),
  },
  handler: async (ctx, { eventId, reason }) => {
    const admin = await requireAdmin(ctx);
    const trimmedReason = reason.trim();
    if (!trimmedReason) throw new Error("A reason is required.");

    const event = await ctx.db.get(eventId);
    if (!event) throw new Error("Event not found.");

    const orders = await ctx.db
      .query("orders")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect();
    const tickets = await ctx.db
      .query("tickets")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect();

    for (const order of orders) {
      if (order.status === "reserved") {
        const ticketType = await ctx.db.get(order.ticketTypeId);
        if (ticketType) {
          await ctx.db.patch(order.ticketTypeId, {
            quantityReserved: Math.max(0, ticketType.quantityReserved - order.quantity),
          });
        }
        await ctx.db.patch(order._id, { status: "expired" });
      }

      if (order.status === "paid") {
        await ctx.db.patch(order._id, { status: "refunded" });
      }
    }

    for (const ticket of tickets) {
      if (ticket.status === "valid" || ticket.status === "pending") {
        await ctx.db.patch(ticket._id, { status: "void" });
      }
    }

    await ctx.db.patch(eventId, { status: "cancelled" });

    const ticketsVoided = tickets.filter(
      (ticket) => ticket.status === "valid" || ticket.status === "pending",
    ).length;

    await logAdminAction(ctx, admin, {
      action: "event.cancelAndRefund",
      targetType: "event",
      targetId: eventId,
      reason: trimmedReason,
      details: { ordersTouched: orders.length, ticketsVoided },
    });

    return { ordersTouched: orders.length, ticketsVoided };
  },
});
