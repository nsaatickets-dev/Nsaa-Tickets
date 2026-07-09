import { mutation, query, MutationCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { requireAdminSecret } from "./admin";

// Organizer pricing tiers, adapted from a competitor's public pricing
// (egotickets.com/pricing: Free 0%, Essential 5%, Pro 7.5%) - kept
// slightly below theirs per product decision. "custom" has no listed
// rate; an admin sets customFeePercent per organizer via
// setOrganizerTierAdmin, same "contact us" pattern as the reference.
export const TIER_FEE_PERCENT: Record<string, number> = {
  free: 0,
  essential: 0.04,
  pro: 0.065,
};

// Pure function (no DB access) so orders.ts can reuse it without an extra
// query round-trip - callers already have the organizerProfiles row (or
// know there isn't one) from their own query.
export function feePercentForTier(
  tier: string | undefined,
  customFeePercent?: number,
): number {
  if (!tier) return TIER_FEE_PERCENT.essential; // no profile yet - legacy/seeded events
  if (tier === "custom") return customFeePercent ?? TIER_FEE_PERCENT.pro;
  return TIER_FEE_PERCENT[tier] ?? TIER_FEE_PERCENT.essential;
}

export const myOrganizerTier = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    return await ctx.db
      .query("organizerProfiles")
      .withIndex("by_organizer", (q) => q.eq("organizerClerkUserId", identity.subject))
      .unique();
  },
});

// Self-serve - organizers can pick their own plan when creating an event.
// "custom" is deliberately excluded here (admin-only, see
// setOrganizerTierAdmin) so nobody can self-assign an arbitrary rate.
export const setOrganizerTier = mutation({
  args: {
    tier: v.union(v.literal("free"), v.literal("essential"), v.literal("pro")),
  },
  handler: async (ctx, { tier }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Sign in required.");

    const existing = await ctx.db
      .query("organizerProfiles")
      .withIndex("by_organizer", (q) => q.eq("organizerClerkUserId", identity.subject))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { tier, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("organizerProfiles", {
        organizerClerkUserId: identity.subject,
        tier,
        updatedAt: Date.now(),
      });
    }
  },
});

// Admin-only (the "Custom / Contact Us" tier) - callable via
// `npx convex run events:setOrganizerTierAdmin '{"adminSecret":"...","organizerClerkUserId":"...","tier":"custom","customFeePercent":0.03}'`
export const setOrganizerTierAdmin = mutation({
  args: {
    adminSecret: v.string(),
    organizerClerkUserId: v.string(),
    tier: v.union(
      v.literal("free"),
      v.literal("essential"),
      v.literal("pro"),
      v.literal("custom"),
    ),
    customFeePercent: v.optional(v.number()),
  },
  handler: async (ctx, { adminSecret, organizerClerkUserId, tier, customFeePercent }) => {
    requireAdminSecret(adminSecret);

    const existing = await ctx.db
      .query("organizerProfiles")
      .withIndex("by_organizer", (q) => q.eq("organizerClerkUserId", organizerClerkUserId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { tier, customFeePercent, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("organizerProfiles", {
        organizerClerkUserId,
        tier,
        customFeePercent,
        updatedAt: Date.now(),
      });
    }
  },
});

// List all published events, most recent first.
export const listPublished = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("events")
      .withIndex("by_status", (q) => q.eq("status", "published"))
      .order("desc")
      .collect();
  },
});

export const listByCategory = query({
  args: { category: v.string() },
  handler: async (ctx, { category }) => {
    return await ctx.db
      .query("events")
      .withIndex("by_status_category", (q) =>
        q.eq("status", "published").eq("category", category),
      )
      .order("desc")
      .collect();
  },
});

export const categorySummary = query({
  args: {},
  handler: async (ctx) => {
    const events = await ctx.db
      .query("events")
      .withIndex("by_status", (q) => q.eq("status", "published"))
      .collect();

    const counts: Record<string, number> = {};
    for (const event of events) {
      counts[event.category] = (counts[event.category] ?? 0) + 1;
    }
    return counts;
  },
});

export const searchPublished = query({
  args: {
    search: v.optional(v.string()),
    category: v.optional(v.string()),
    city: v.optional(v.string()),
    startsAfter: v.optional(v.number()),
    startsBefore: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const events = await ctx.db
      .query("events")
      .withIndex("by_status", (q) => q.eq("status", "published"))
      .order("desc")
      .collect();

    const term = args.search?.trim().toLowerCase();

    return events.filter((event) => {
      const matchesTerm =
        !term ||
        [
          event.title,
          event.description,
          event.venue,
          event.address,
          event.city,
          event.category,
          event.organizerName,
        ]
          .join(" ")
          .toLowerCase()
          .includes(term);

      const matchesCategory =
        !args.category || event.category === args.category;
      const matchesCity =
        !args.city || event.city.toLowerCase() === args.city.toLowerCase();
      const matchesStart =
        !args.startsAfter || event.startsAt >= args.startsAfter;
      const matchesEnd =
        !args.startsBefore || event.startsAt <= args.startsBefore;

      return (
        matchesTerm &&
        matchesCategory &&
        matchesCity &&
        matchesStart &&
        matchesEnd
      );
    });
  },
});

export const getById = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    return await ctx.db.get(eventId);
  },
});

// Ticket types for one event, with live availability computed from
// quantityTotal - quantitySold - quantityReserved.
export const ticketTypesForEvent = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const types = await ctx.db
      .query("ticketTypes")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect();

    return types.map((t) => ({
      ...t,
      quantityAvailable: t.quantityTotal - t.quantitySold - t.quantityReserved,
    }));
  },
});

// ---- Organizer self-serve dashboard ----
// Ownership is always derived from the server-verified Clerk identity
// (identity.subject), never a client-supplied id - same pattern as
// createReservation in orders.ts. Mutations throw when unauthorized;
// queries return an empty/null result instead, matching the existing
// ticketsForCurrentUserDetailed convention in tickets.ts.

export const eventsForCurrentOrganizer = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    return await ctx.db
      .query("events")
      .withIndex("by_organizer", (q) =>
        q.eq("organizerClerkUserId", identity.subject),
      )
      .order("desc")
      .collect();
  },
});

// Ticket sales are separate from event ownership so an organizer can see
// how their event is performing without exposing this to other users.
export const salesSummaryForEvent = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const event = await ctx.db.get(eventId);
    if (!event || event.organizerClerkUserId !== identity.subject) return null;

    const ticketTypes = await ctx.db
      .query("ticketTypes")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect();

    const orders = await ctx.db
      .query("orders")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect();

    const paidOrders = orders.filter((order) => order.status === "paid");

    return {
      ticketTypes: ticketTypes.map((t) => ({
        ...t,
        quantityAvailable: t.quantityTotal - t.quantitySold - t.quantityReserved,
      })),
      ticketsSold: ticketTypes.reduce((sum, t) => sum + t.quantitySold, 0),
      grossRevenueGHS: paidOrders.reduce((sum, order) => sum + order.totalGHS, 0),
      ordersPaid: paidOrders.length,
      ordersPending: orders.filter((order) => order.status === "reserved").length,
    };
  },
});

async function requireOwnedEvent(ctx: MutationCtx, eventId: Id<"events">) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Sign in required.");

  const event = await ctx.db.get(eventId);
  if (!event) throw new Error("Event not found.");
  if (event.organizerClerkUserId !== identity.subject) {
    throw new Error("You do not have access to this event.");
  }
  return { identity, event };
}

const eventFields = {
  title: v.string(),
  description: v.string(),
  venue: v.string(),
  address: v.string(),
  city: v.string(),
  startsAt: v.number(),
  endsAt: v.optional(v.number()),
  heroImageUrl: v.optional(v.string()),
  category: v.string(),
  organizerName: v.string(),
  organizerPayoutPhone: v.optional(v.string()),
};

export const createEvent = mutation({
  args: eventFields,
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Sign in required to create an event.");

    return await ctx.db.insert("events", {
      ...args,
      status: "draft",
      organizerClerkUserId: identity.subject,
      createdAt: Date.now(),
    });
  },
});

export const updateEvent = mutation({
  args: { eventId: v.id("events"), ...eventFields },
  handler: async (ctx, { eventId, ...fields }) => {
    await requireOwnedEvent(ctx, eventId);
    await ctx.db.patch(eventId, fields);
  },
});

// Cancellation is deliberately not offered here: cancelling a published
// event with paid orders needs a refund flow (see README "Known gaps"),
// which doesn't exist yet. Only the safe draft <-> published toggle is
// exposed until that's built.
export const setEventStatus = mutation({
  args: {
    eventId: v.id("events"),
    status: v.union(v.literal("draft"), v.literal("published")),
  },
  handler: async (ctx, { eventId, status }) => {
    await requireOwnedEvent(ctx, eventId);
    await ctx.db.patch(eventId, { status });
  },
});

export const createTicketType = mutation({
  args: {
    eventId: v.id("events"),
    name: v.string(),
    priceGHS: v.number(),
    quantityTotal: v.number(),
  },
  handler: async (ctx, args) => {
    await requireOwnedEvent(ctx, args.eventId);
    return await ctx.db.insert("ticketTypes", {
      eventId: args.eventId,
      name: args.name,
      priceGHS: args.priceGHS,
      quantityTotal: args.quantityTotal,
      quantitySold: 0,
      quantityReserved: 0,
    });
  },
});

export const updateTicketType = mutation({
  args: {
    ticketTypeId: v.id("ticketTypes"),
    name: v.string(),
    priceGHS: v.number(),
    quantityTotal: v.number(),
  },
  handler: async (ctx, args) => {
    const ticketType = await ctx.db.get(args.ticketTypeId);
    if (!ticketType) throw new Error("Ticket type not found.");
    await requireOwnedEvent(ctx, ticketType.eventId);

    if (
      args.quantityTotal <
      ticketType.quantitySold + ticketType.quantityReserved
    ) {
      throw new Error(
        "Quantity can't be reduced below tickets already sold or reserved.",
      );
    }

    await ctx.db.patch(args.ticketTypeId, {
      name: args.name,
      priceGHS: args.priceGHS,
      quantityTotal: args.quantityTotal,
    });
  },
});

export const deleteTicketType = mutation({
  args: { ticketTypeId: v.id("ticketTypes") },
  handler: async (ctx, { ticketTypeId }) => {
    const ticketType = await ctx.db.get(ticketTypeId);
    if (!ticketType) throw new Error("Ticket type not found.");
    await requireOwnedEvent(ctx, ticketType.eventId);

    if (ticketType.quantitySold + ticketType.quantityReserved > 0) {
      throw new Error(
        "Can't delete a ticket type with sold or reserved tickets.",
      );
    }

    await ctx.db.delete(ticketTypeId);
  },
});

// Seed demo events. Intended to be called once from the Convex dashboard
// function runner for local/demo data - unrelated to organizer-created
// events above (seeded events have no organizerClerkUserId, so they
// won't appear in any organizer's dashboard).
export const seedDemoEvent = mutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const day = 1000 * 60 * 60 * 24;

    const demoEvents = [
      {
        event: {
          title: "Black Star Highlife Night",
          description:
            "A polished live highlife and Afrobeats concert with seated and standing sections at the National Theatre.",
          venue: "National Theatre",
          address: "South Liberia Road, Accra",
          city: "Accra",
          startsAt: now + day * 12,
          heroImageUrl:
            "https://images.unsplash.com/photo-1506157786151-b8491531f063?auto=format&fit=crop&w=1600&q=80",
          category: "concert",
          organizerName: "Nsaa Live Events",
          organizerPayoutPhone: "0240000000",
        },
        tickets: [
          { name: "Early Bird", priceGHS: 120, quantityTotal: 180 },
          { name: "Gold Circle", priceGHS: 280, quantityTotal: 80 },
          { name: "Group of 5", priceGHS: 500, quantityTotal: 40 },
        ],
      },
      {
        event: {
          title: "Africa Product Leaders Summit",
          description:
            "A full-day conference for founders, product managers, designers, and investors building across African markets.",
          venue: "Kempinski Hotel Gold Coast City",
          address: "Gamel Abdul Nasser Avenue, Accra",
          city: "Accra",
          startsAt: now + day * 21,
          heroImageUrl:
            "https://images.unsplash.com/photo-1540575467063-178a50c2df87?auto=format&fit=crop&w=1600&q=80",
          category: "conference",
          organizerName: "Frontier Product Forum",
          organizerPayoutPhone: "0240000000",
        },
        tickets: [
          { name: "Founder Pass", priceGHS: 450, quantityTotal: 120 },
          { name: "Student", priceGHS: 90, quantityTotal: 60 },
          { name: "Team of 4", priceGHS: 1500, quantityTotal: 25 },
        ],
      },
      {
        event: {
          title: "Kumasi Derby Viewing Festival",
          description:
            "A family-friendly sports screening with food vendors, fan zones, and covered seating in Kumasi.",
          venue: "Rattray Park",
          address: "Victoria Opoku Ware Road, Kumasi",
          city: "Kumasi",
          startsAt: now + day * 8,
          heroImageUrl:
            "https://images.unsplash.com/photo-1505842465776-3d90f6163103?auto=format&fit=crop&w=1600&q=80",
          category: "sports",
          organizerName: "Ashanti Sports House",
          organizerPayoutPhone: "0240000000",
        },
        tickets: [
          { name: "Fan Zone", priceGHS: 35, quantityTotal: 300 },
          { name: "Covered Seating", priceGHS: 75, quantityTotal: 120 },
          { name: "Family of 4", priceGHS: 120, quantityTotal: 70 },
        ],
      },
      {
        event: {
          title: "The White Garden Wedding Showcase",
          description:
            "A calm afternoon showcase for couples planning ceremonies, receptions, photography, decor, and catering.",
          venue: "The Fitzgerald",
          address: "East Legon, Accra",
          city: "Accra",
          startsAt: now + day * 28,
          heroImageUrl:
            "https://images.unsplash.com/photo-1519741497674-611481863552?auto=format&fit=crop&w=1600&q=80",
          category: "wedding",
          organizerName: "Gold Coast Weddings",
          organizerPayoutPhone: "0240000000",
        },
        tickets: [
          { name: "Couples Admission", priceGHS: 180, quantityTotal: 90 },
          { name: "Planner Pass", priceGHS: 120, quantityTotal: 50 },
        ],
      },
      {
        event: {
          title: "Laugh Lab Accra",
          description:
            "A sharp comedy night with stand-up sets, improv games, and special guest performers from Accra and Tema.",
          venue: "Snap Cinemas",
          address: "Aviation Road, Accra",
          city: "Accra",
          startsAt: now + day * 16,
          heroImageUrl:
            "https://images.unsplash.com/photo-1527224857830-43a7acc85260?auto=format&fit=crop&w=1600&q=80",
          category: "comedy",
          organizerName: "Laugh Lab Ghana",
          organizerPayoutPhone: "0240000000",
        },
        tickets: [
          { name: "Standard Seat", priceGHS: 80, quantityTotal: 150 },
          { name: "Front Row", priceGHS: 140, quantityTotal: 30 },
        ],
      },
      {
        event: {
          title: "Ananse Stories on Stage",
          description:
            "A theatre evening blending Ghanaian folklore, live percussion, and contemporary stage design.",
          venue: "Efua Sutherland Drama Studio",
          address: "University of Ghana, Legon",
          city: "Accra",
          startsAt: now + day * 19,
          heroImageUrl:
            "https://images.unsplash.com/photo-1503095396549-807759245b35?auto=format&fit=crop&w=1600&q=80",
          category: "theatre",
          organizerName: "Legon Stage Company",
          organizerPayoutPhone: "0240000000",
        },
        tickets: [
          { name: "General Seat", priceGHS: 60, quantityTotal: 180 },
          { name: "Student Seat", priceGHS: 35, quantityTotal: 70 },
        ],
      },
      {
        event: {
          title: "Night of Worship at Independence Square",
          description:
            "A large outdoor worship gathering with choirs, spoken word, and prayer leaders from across Ghana.",
          venue: "Black Star Square",
          address: "Osu, Accra",
          city: "Accra",
          startsAt: now + day * 25,
          heroImageUrl:
            "https://images.unsplash.com/photo-1438232992991-995b7058bbb3?auto=format&fit=crop&w=1600&q=80",
          category: "religious",
          organizerName: "Accra Worship Collective",
          organizerPayoutPhone: "0240000000",
        },
        tickets: [
          { name: "Free Registration", priceGHS: 0, quantityTotal: 1000 },
          { name: "Reserved Seating", priceGHS: 50, quantityTotal: 200 },
        ],
      },
      {
        event: {
          title: "Creative Business Workshop",
          description:
            "A practical workshop for photographers, stylists, designers, and creators building paid creative businesses.",
          venue: "Impact Hub Accra",
          address: "F 393/4 Otswe Street, Osu",
          city: "Accra",
          startsAt: now + day * 11,
          heroImageUrl:
            "https://images.unsplash.com/photo-1517048676732-d65bc937f952?auto=format&fit=crop&w=1600&q=80",
          category: "workshop",
          organizerName: "Creative Desk Ghana",
          organizerPayoutPhone: "0240000000",
        },
        tickets: [
          { name: "Workshop Seat", priceGHS: 220, quantityTotal: 45 },
          { name: "Mentor Table", priceGHS: 380, quantityTotal: 12 },
        ],
      },
      {
        event: {
          title: "Osu Rooftop Select",
          description:
            "A curated nightlife set with DJs, table service, and controlled door entry at a rooftop venue in Osu.",
          venue: "Skybar 25",
          address: "Alto Tower, Villaggio Vista, Accra",
          city: "Accra",
          startsAt: now + day * 5,
          heroImageUrl:
            "https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=1600&q=80",
          category: "nightlife",
          organizerName: "Osu Select",
          organizerPayoutPhone: "0240000000",
        },
        tickets: [
          { name: "Entry Before 10pm", priceGHS: 100, quantityTotal: 120 },
          { name: "Table Deposit", priceGHS: 600, quantityTotal: 20 },
        ],
      },
    ];

    const eventIds = [];
    for (const demo of demoEvents) {
      const eventId = await ctx.db.insert("events", {
        ...demo.event,
        status: "published",
        createdAt: now,
      });
      eventIds.push(eventId);

      for (const ticket of demo.tickets) {
        await ctx.db.insert("ticketTypes", {
          eventId,
          name: ticket.name,
          priceGHS: ticket.priceGHS,
          quantityTotal: ticket.quantityTotal,
          quantitySold: 0,
          quantityReserved: 0,
        });
      }
    }

    return eventIds;
  },
});
