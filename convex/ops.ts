import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireAdminSecret } from "./admin";

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
  args: { adminSecret: v.string() },
  handler: async (ctx, { adminSecret }) => {
    requireAdminSecret(adminSecret);

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

export const overview = query({
  args: { adminSecret: v.string() },
  handler: async (ctx, { adminSecret }) => {
    requireAdminSecret(adminSecret);

    const [organizerInquiries, contactMessages, events, payouts] = await Promise.all([
      ctx.db.query("organizerInquiries").collect(),
      ctx.db.query("contactMessages").collect(),
      ctx.db.query("events").collect(),
      ctx.db.query("payouts").collect(),
    ]);

    return {
      organizerInquiries: organizerInquiries.sort((a, b) => b.createdAt - a.createdAt).slice(0, 80),
      contactMessages: contactMessages.sort((a, b) => b.createdAt - a.createdAt).slice(0, 80),
      events: events.sort((a, b) => b.createdAt - a.createdAt).slice(0, 120),
      payouts: payouts.sort((a, b) => b.createdAt - a.createdAt).slice(0, 120),
    };
  },
});

export const setOrganizerInquiryStatus = mutation({
  args: {
    adminSecret: v.string(),
    inquiryId: v.id("organizerInquiries"),
    status: v.union(v.literal("new"), v.literal("contacted"), v.literal("closed")),
  },
  handler: async (ctx, { adminSecret, inquiryId, status }) => {
    requireAdminSecret(adminSecret);
    await ctx.db.patch(inquiryId, { status });
  },
});

export const setContactMessageStatus = mutation({
  args: {
    adminSecret: v.string(),
    messageId: v.id("contactMessages"),
    status: v.union(v.literal("new"), v.literal("contacted"), v.literal("closed")),
  },
  handler: async (ctx, { adminSecret, messageId, status }) => {
    requireAdminSecret(adminSecret);
    await ctx.db.patch(messageId, { status });
  },
});

export const setEventStatusAdmin = mutation({
  args: {
    adminSecret: v.string(),
    eventId: v.id("events"),
    status: v.union(v.literal("draft"), v.literal("published")),
  },
  handler: async (ctx, { adminSecret, eventId, status }) => {
    requireAdminSecret(adminSecret);
    await ctx.db.patch(eventId, { status });
  },
});

export const cancelEventAndMarkRefunded = mutation({
  args: {
    adminSecret: v.string(),
    eventId: v.id("events"),
  },
  handler: async (ctx, { adminSecret, eventId }) => {
    requireAdminSecret(adminSecret);

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

    return {
      ordersTouched: orders.length,
      ticketsVoided: tickets.filter((ticket) => ticket.status === "valid" || ticket.status === "pending").length,
    };
  },
});
