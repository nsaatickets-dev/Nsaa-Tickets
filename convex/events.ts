import { mutation, query, internalQuery, MutationCtx, QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { requireAdminSecret, requireAdmin, logAdminAction } from "./admin";
import {
  requireNonEmpty,
  optionalTrimmed,
  requireValidGhanaPhone,
  requirePositiveNumber,
  requirePositiveInteger,
} from "./validation";

// Organizer pricing tiers. The standard paid rate is a flat 4.5%:
// enough room for Moolre's processing share plus Nsaa's margin, while
// every self-serve paid tier stays strictly below the 5% local Essential
// benchmark. No flat add-on means low-priced tickets stay competitive too.
// "custom" has no listed rate; an admin sets customFeePercent per
// organizer via setOrganizerTierAdmin.
export const TIER_FEE_PERCENT: Record<string, number> = {
  free: 0,
  essential: 0.045,
  pro: 0.049,
};

export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "event";
}

function eventSlug(title: string, startsAt: number): string {
  const date = Number.isFinite(startsAt)
    ? new Date(startsAt).toISOString().slice(0, 10)
    : "date-tba";
  return `${slugify(title)}-${date}`;
}

function eventVenueSlug(event: Pick<Doc<"events">, "venue" | "venueSlug">): string {
  return event.venueSlug || slugify(event.venue);
}

function eventOrganizerSlug(
  event: Pick<Doc<"events">, "organizerName" | "organizerSlug">,
): string {
  return event.organizerSlug || slugify(event.organizerName);
}

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

export function computePlatformFee(ticketSubtotalGHS: number, feePercent: number): number {
  if (ticketSubtotalGHS <= 0) return 0;
  // Floor to the nearest pesewa so sub-cedi rounding never turns a
  // below-5% tier into an effective 5% charge on low-priced tickets.
  return Math.floor(ticketSubtotalGHS * feePercent * 100) / 100;
}

export const generateHeroImageUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Sign in required to upload an event image.");
    return await ctx.storage.generateUploadUrl();
  },
});

export const resolveHeroImageUpload = mutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Sign in required to upload an event image.");

    const url = await ctx.storage.getUrl(storageId);
    if (!url) throw new Error("Uploaded image could not be found.");
    return url;
  },
});

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

// Resolves who to notify when one of an organizer's tickets sells. Returns
// null for legacy/seeded events (no organizerClerkUserId) or an organizer
// who never set a contact email on their profile - callers should treat
// that as "nothing to send", not an error.
export const getOrganizerContactForEvent = internalQuery({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const event = await ctx.db.get(eventId);
    if (!event?.organizerClerkUserId) return null;

    const profile = await ctx.db
      .query("organizerProfiles")
      .withIndex("by_organizer", (q) =>
        q.eq("organizerClerkUserId", event.organizerClerkUserId!),
      )
      .unique();
    if (!profile?.contactEmail) return null;

    return { contactEmail: profile.contactEmail, organizerName: event.organizerName };
  },
});

export const myOrganizerProfile = query({
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
      const now = Date.now();
      await ctx.db.insert("organizerProfiles", {
        organizerClerkUserId: identity.subject,
        tier,
        createdAt: now,
        updatedAt: now,
      });
    }
  },
});

export const completeOrganizerOnboarding = mutation({
  args: {
    displayName: v.string(),
    contactName: v.optional(v.string()),
    contactPhone: v.string(),
    city: v.string(),
    payoutPhone: v.optional(v.string()),
    websiteUrl: v.optional(v.string()),
    primaryEventType: v.optional(v.string()),
    tier: v.union(v.literal("free"), v.literal("essential"), v.literal("pro")),
  },
  handler: async (ctx, { tier, ...fields }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Sign in required.");

    const profileFields = sanitizeOrganizerProfileFields(fields);
    const now = Date.now();
    const contactEmail =
      typeof identity.email === "string" && identity.email.trim()
        ? identity.email.trim().toLowerCase()
        : undefined;

    const existing = await ctx.db
      .query("organizerProfiles")
      .withIndex("by_organizer", (q) => q.eq("organizerClerkUserId", identity.subject))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        ...profileFields,
        contactEmail,
        tier,
        onboardingCompletedAt: existing.onboardingCompletedAt ?? now,
        updatedAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert("organizerProfiles", {
      organizerClerkUserId: identity.subject,
      ...profileFields,
      contactEmail,
      tier,
      onboardingCompletedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  },
});

// Admin God Mode - sets an organizer's platform fee tier, including the
// "Custom / Contact Us" tier no self-serve flow offers. Now surfaced in
// the admin dashboard's Organizers tab (previously CLI-only via
// `npx convex run events:setOrganizerTierAdmin`).
export const setOrganizerTierAdmin = mutation({
  args: {
    organizerClerkUserId: v.string(),
    tier: v.union(
      v.literal("free"),
      v.literal("essential"),
      v.literal("pro"),
      v.literal("custom"),
    ),
    customFeePercent: v.optional(v.number()),
  },
  handler: async (ctx, { organizerClerkUserId, tier, customFeePercent }) => {
    const admin = await requireAdmin(ctx);
    if (
      tier === "custom" &&
      customFeePercent !== undefined &&
      (customFeePercent < 0 || customFeePercent >= 0.05)
    ) {
      throw new Error("Custom platform fee must be at least 0% and strictly below 5%.");
    }

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

    await logAdminAction(ctx, admin, {
      action: "organizer.setTier",
      targetType: "organizerProfile",
      targetId: organizerClerkUserId,
      details: { tier, customFeePercent },
    });
  },
});

// Admin God Mode: blocks (or unblocks) self-serve event creation for an
// organizer without touching events they've already published - an admin
// can still draft/cancel those individually via the Events tab. There's
// no account-level "ban" for organizers (they authenticate via Clerk, not
// a Nsaa-owned user table), so this flag on their pricing profile is the
// enforcement point instead.
export const adminSetOrganizerSuspension = mutation({
  args: {
    organizerClerkUserId: v.string(),
    suspended: v.boolean(),
    reason: v.string(),
  },
  handler: async (ctx, { organizerClerkUserId, suspended, reason }) => {
    const admin = await requireAdmin(ctx);
    const trimmedReason = reason.trim();
    if (!trimmedReason) throw new Error("A reason is required.");

    const existing = await ctx.db
      .query("organizerProfiles")
      .withIndex("by_organizer", (q) => q.eq("organizerClerkUserId", organizerClerkUserId))
      .unique();

    const patch = {
      suspended,
      suspendedReason: suspended ? trimmedReason : undefined,
      suspendedAt: suspended ? Date.now() : undefined,
    };

    if (existing) {
      await ctx.db.patch(existing._id, { ...patch, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("organizerProfiles", {
        organizerClerkUserId,
        tier: "essential",
        ...patch,
        updatedAt: Date.now(),
      });
    }

    await logAdminAction(ctx, admin, {
      action: suspended ? "organizer.suspend" : "organizer.unsuspend",
      targetType: "organizerProfile",
      targetId: organizerClerkUserId,
      reason: trimmedReason,
    });
  },
});

// Admin God Mode: lists every organizer profile (self-serve pricing/
// suspension record) plus a derived list of organizers who own published
// events but have no profile row yet (legacy/seeded), for the Organizers
// tab - profile-less organizers show up so an admin can still suspend or
// tier them.
export const adminListOrganizers = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);

    const [profiles, events] = await Promise.all([
      ctx.db.query("organizerProfiles").collect(),
      ctx.db.query("events").collect(),
    ]);

    const byOrganizerId = new Map(profiles.map((p) => [p.organizerClerkUserId, p]));
    const eventCounts = new Map<string, { name: string; count: number }>();
    for (const event of events) {
      if (!event.organizerClerkUserId) continue;
      const entry = eventCounts.get(event.organizerClerkUserId) ?? {
        name: event.organizerName,
        count: 0,
      };
      entry.count += 1;
      eventCounts.set(event.organizerClerkUserId, entry);
    }

    const organizerIds = new Set([...byOrganizerId.keys(), ...eventCounts.keys()]);

    return [...organizerIds].map((organizerClerkUserId) => {
      const profile = byOrganizerId.get(organizerClerkUserId);
      const derived = eventCounts.get(organizerClerkUserId);
      return {
        organizerClerkUserId,
        displayName: profile?.displayName || derived?.name || organizerClerkUserId,
        tier: profile?.tier ?? "essential",
        customFeePercent: profile?.customFeePercent,
        suspended: profile?.suspended ?? false,
        suspendedReason: profile?.suspendedReason,
        eventCount: derived?.count ?? 0,
      };
    });
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

async function enrichEventsWithTicketSummary(ctx: QueryCtx, events: Doc<"events">[]) {
  const enriched = [];
  for (const event of events) {
    const ticketTypes = await ctx.db
      .query("ticketTypes")
      .withIndex("by_event", (q) => q.eq("eventId", event._id))
      .collect();

    const available = ticketTypes.reduce(
      (sum, ticket) => sum + ticket.quantityTotal - ticket.quantitySold - ticket.quantityReserved,
      0,
    );
    const totalInventory = ticketTypes.reduce((sum, ticket) => sum + ticket.quantityTotal, 0);
    const prices = ticketTypes.map((ticket) => ticket.priceGHS);
    const paidPrices = prices.filter((price) => price > 0);
    const minPriceGHS = prices.length ? Math.min(...prices) : null;
    const maxPriceGHS = prices.length ? Math.max(...prices) : null;

    enriched.push({
      ...event,
      slug: event.slug || eventSlug(event.title, event.startsAt),
      organizerSlug: eventOrganizerSlug(event),
      venueSlug: eventVenueSlug(event),
      minPriceGHS,
      maxPriceGHS,
      isFree: prices.length > 0 && paidPrices.length === 0,
      hasPaidTickets: paidPrices.length > 0,
      ticketsAvailable: available,
      isSellingFast:
        available > 0 &&
        totalInventory > 0 &&
        available <= Math.max(10, Math.ceil(totalInventory * 0.12)),
    });
  }
  return enriched;
}

export const searchPublishedPage = query({
  args: {
    search: v.optional(v.string()),
    category: v.optional(v.string()),
    city: v.optional(v.string()),
    startsAfter: v.optional(v.number()),
    startsBefore: v.optional(v.number()),
    price: v.optional(v.union(v.literal("all"), v.literal("free"), v.literal("paid"))),
    availability: v.optional(v.union(v.literal("any"), v.literal("selling_fast"))),
    ageRating: v.optional(v.string()),
    page: v.optional(v.number()),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const startsAfter = args.startsAfter ?? 0;
    const startsBefore = args.startsBefore ?? Number.MAX_SAFE_INTEGER;
    const page = Math.max(1, Math.floor(args.page ?? 1));
    const pageSize = Math.min(48, Math.max(6, Math.floor(args.pageSize ?? 18)));

    let candidates: Doc<"events">[];
    if (args.category) {
      candidates = await ctx.db
        .query("events")
        .withIndex("by_status_category_startsAt", (q) =>
          q.eq("status", "published").eq("category", args.category!).gte("startsAt", startsAfter),
        )
        .order("asc")
        .take(400);
    } else if (args.city) {
      candidates = await ctx.db
        .query("events")
        .withIndex("by_status_city_startsAt", (q) =>
          q.eq("status", "published").eq("city", args.city!).gte("startsAt", startsAfter),
        )
        .order("asc")
        .take(400);
    } else {
      candidates = await ctx.db
        .query("events")
        .withIndex("by_status_startsAt", (q) =>
          q.eq("status", "published").gte("startsAt", startsAfter),
        )
        .order("asc")
        .take(400);
    }

    // Once an event is over it should stop appearing in default discovery.
    // startsAt alone isn't a safe cutoff (a still-running multi-day event
    // would vanish mid-run), so this checks endsAt when the organizer set
    // one. Only applied when the caller didn't ask for an explicit date
    // range - the UI's date pickers only ever request future ranges today,
    // but this keeps any future "show past events too" caller unaffected.
    const hidesPastByDefault = args.startsAfter === undefined && args.startsBefore === undefined;

    const term = args.search?.trim().toLowerCase();
    const filteredByEventFields = candidates.filter((event) => {
      if (event.startsAt > startsBefore) return false;
      if (hidesPastByDefault && (event.endsAt ?? event.startsAt) < Date.now()) return false;
      if (args.ageRating && event.ageRating && event.ageRating !== args.ageRating) return false;
      if (!term) return true;
      return [
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
    });

    const enriched = await enrichEventsWithTicketSummary(ctx, filteredByEventFields);
    const filtered = enriched.filter((event) => {
      if (args.price === "free" && !event.isFree) return false;
      if (args.price === "paid" && !event.hasPaidTickets) return false;
      if (args.availability === "selling_fast" && !event.isSellingFast) return false;
      return true;
    });

    const total = filtered.length;
    const start = (page - 1) * pageSize;
    const items = filtered.slice(start, start + pageSize);

    return {
      items,
      page,
      pageSize,
      total,
      hasNextPage: start + pageSize < total,
    };
  },
});

export const getById = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    return await ctx.db.get(eventId);
  },
});

export const getBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const event = await ctx.db
      .query("events")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    if (!event || event.status !== "published") return null;
    return {
      ...event,
      slug: event.slug || eventSlug(event.title, event.startsAt),
      organizerSlug: eventOrganizerSlug(event),
      venueSlug: eventVenueSlug(event),
    };
  },
});

export const getPublicEvent = query({
  args: {
    eventId: v.optional(v.id("events")),
    slug: v.optional(v.string()),
  },
  handler: async (ctx, { eventId, slug }) => {
    const event = eventId
      ? await ctx.db.get(eventId)
      : slug
        ? await ctx.db
            .query("events")
            .withIndex("by_slug", (q) => q.eq("slug", slug))
            .first()
        : null;

    if (!event || event.status !== "published") return null;
    return {
      ...event,
      slug: event.slug || eventSlug(event.title, event.startsAt),
      organizerSlug: eventOrganizerSlug(event),
      venueSlug: eventVenueSlug(event),
    };
  },
});

// Ticket types for one event, with live availability computed from
// quantityTotal - quantitySold - quantityReserved.
export const ticketTypesForEvent = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const event = await ctx.db.get(eventId);
    const organizerProfile = event?.organizerClerkUserId
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
    const types = await ctx.db
      .query("ticketTypes")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect();

    return types.map((t) => {
      const serviceFeeGHS = computePlatformFee(t.priceGHS, feePercent);
      return {
        ...t,
        quantityAvailable: t.quantityTotal - t.quantitySold - t.quantityReserved,
        serviceFeeGHS,
        totalPerTicketGHS:
          t.priceGHS <= 0
            ? 0
            : Math.round((t.priceGHS + serviceFeeGHS) * 100) / 100,
      };
    });
  },
});

export const listVenueProfiles = query({
  args: {},
  handler: async (ctx) => {
    const published = await ctx.db
      .query("events")
      .withIndex("by_status", (q) => q.eq("status", "published"))
      .collect();
    const explicitProfiles = await ctx.db.query("venueProfiles").collect();

    const profiles = new Map<string, any>();
    for (const profile of explicitProfiles) {
      profiles.set(profile.slug, {
        slug: profile.slug,
        name: profile.name,
        city: profile.city,
        address: profile.address,
        description: profile.description,
        heroImageUrl: profile.heroImageUrl,
        mapUrl: profile.mapUrl,
        verified: Boolean(profile.verifiedAt),
        eventCount: 0,
      });
    }

    for (const event of published) {
      const slug = eventVenueSlug(event);
      const existing = profiles.get(slug);
      profiles.set(slug, {
        slug,
        name: existing?.name || event.venue,
        city: existing?.city || event.city,
        address: existing?.address || event.address,
        description: existing?.description,
        heroImageUrl: existing?.heroImageUrl || event.heroImageUrl,
        mapUrl: existing?.mapUrl,
        verified: existing?.verified || false,
        eventCount: (existing?.eventCount ?? 0) + 1,
      });
    }

    return [...profiles.values()].sort((a, b) => b.eventCount - a.eventCount || a.name.localeCompare(b.name));
  },
});

export const getVenueProfile = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const explicit = await ctx.db
      .query("venueProfiles")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    const allPublished = await ctx.db
      .query("events")
      .withIndex("by_status", (q) => q.eq("status", "published"))
      .collect();
    const events = allPublished
      .filter((event) => eventVenueSlug(event) === slug)
      .sort((a, b) => a.startsAt - b.startsAt);

    if (!explicit && events.length === 0) return null;
    const first = events[0];
    return {
      profile: {
        slug,
        name: explicit?.name || first?.venue || "Venue",
        city: explicit?.city || first?.city || "",
        address: explicit?.address || first?.address,
        description: explicit?.description,
        heroImageUrl: explicit?.heroImageUrl || first?.heroImageUrl,
        mapUrl: explicit?.mapUrl,
        verified: Boolean(explicit?.verifiedAt),
      },
      events: await enrichEventsWithTicketSummary(ctx, events),
    };
  },
});

export const listOrganizerProfilesPublic = query({
  args: {},
  handler: async (ctx) => {
    const published = await ctx.db
      .query("events")
      .withIndex("by_status", (q) => q.eq("status", "published"))
      .collect();
    const explicitProfiles = await ctx.db.query("organizerPublicProfiles").collect();

    const profiles = new Map<string, any>();
    for (const profile of explicitProfiles) {
      profiles.set(profile.slug, {
        slug: profile.slug,
        displayName: profile.displayName,
        description: profile.description,
        websiteUrl: profile.websiteUrl,
        logoUrl: profile.logoUrl,
        verified: Boolean(profile.verifiedAt),
        eventCount: 0,
      });
    }

    for (const event of published) {
      const slug = eventOrganizerSlug(event);
      const existing = profiles.get(slug);
      profiles.set(slug, {
        slug,
        displayName: existing?.displayName || event.organizerName,
        description: existing?.description,
        websiteUrl: existing?.websiteUrl,
        logoUrl: existing?.logoUrl,
        verified: existing?.verified || false,
        eventCount: (existing?.eventCount ?? 0) + 1,
      });
    }

    return [...profiles.values()].sort((a, b) => b.eventCount - a.eventCount || a.displayName.localeCompare(b.displayName));
  },
});

export const getOrganizerProfilePublic = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const explicit = await ctx.db
      .query("organizerPublicProfiles")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    const allPublished = await ctx.db
      .query("events")
      .withIndex("by_status", (q) => q.eq("status", "published"))
      .collect();
    const events = allPublished
      .filter((event) => eventOrganizerSlug(event) === slug)
      .sort((a, b) => a.startsAt - b.startsAt);

    if (!explicit && events.length === 0) return null;
    const first = events[0];
    return {
      profile: {
        slug,
        displayName: explicit?.displayName || first?.organizerName || "Organizer",
        description: explicit?.description,
        websiteUrl: explicit?.websiteUrl,
        logoUrl: explicit?.logoUrl,
        verified: Boolean(explicit?.verifiedAt),
      },
      events: await enrichEventsWithTicketSummary(ctx, events),
    };
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

// Used by the nav to decide whether to offer the organizer context switch.
// "Organizer" here means owns at least one event OR has picked a pricing
// tier - either is enough to have a dashboard worth switching into, even
// before their first event exists.
export const organizerStatus = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return { isOrganizer: false };

    const ownedEvent = await ctx.db
      .query("events")
      .withIndex("by_organizer", (q) =>
        q.eq("organizerClerkUserId", identity.subject),
      )
      .first();

    const profile = await ctx.db
      .query("organizerProfiles")
      .withIndex("by_organizer", (q) => q.eq("organizerClerkUserId", identity.subject))
      .unique();

    return {
      isOrganizer: Boolean(ownedEvent || profile),
      onboardingComplete: Boolean(ownedEvent || profile?.onboardingCompletedAt),
    };
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
    const referralSummary = new Map<string, { code: string; orders: number; tickets: number; revenueGHS: number }>();
    for (const order of paidOrders) {
      const code = order.referralCode || "direct";
      const current = referralSummary.get(code) ?? {
        code,
        orders: 0,
        tickets: 0,
        revenueGHS: 0,
      };
      current.orders += 1;
      current.tickets += order.quantity;
      current.revenueGHS = Math.round((current.revenueGHS + order.totalGHS) * 100) / 100;
      referralSummary.set(code, current);
    }

    return {
      ticketTypes: ticketTypes.map((t) => ({
        ...t,
        quantityAvailable: t.quantityTotal - t.quantitySold - t.quantityReserved,
      })),
      ticketsSold: ticketTypes.reduce((sum, t) => sum + t.quantitySold, 0),
      grossRevenueGHS: paidOrders.reduce((sum, order) => sum + order.totalGHS, 0),
      ordersPaid: paidOrders.length,
      ordersPending: orders.filter((order) => order.status === "reserved").length,
      referralSummary: [...referralSummary.values()].sort((a, b) => b.revenueGHS - a.revenueGHS),
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
  ageRating: v.optional(v.string()),
  organizerName: v.string(),
  organizerPayoutPhone: v.optional(v.string()),
};

interface RawEventFields {
  title: string;
  description: string;
  venue: string;
  address: string;
  city: string;
  startsAt: number;
  endsAt?: number;
  heroImageUrl?: string;
  category: string;
  ageRating?: string;
  organizerName: string;
  organizerPayoutPhone?: string;
}

const ticketTypeInput = {
  name: v.string(),
  priceGHS: v.number(),
  quantityTotal: v.number(),
};

interface RawTicketTypeFields {
  name: string;
  priceGHS: number;
  quantityTotal: number;
}

interface RawOrganizerProfileFields {
  displayName: string;
  contactName?: string;
  contactPhone: string;
  city: string;
  payoutPhone?: string;
  websiteUrl?: string;
  primaryEventType?: string;
}

function sanitizeOrganizerProfileFields(fields: RawOrganizerProfileFields) {
  const websiteUrl = optionalTrimmed(fields.websiteUrl, 2000);
  if (websiteUrl && !/^https?:\/\//i.test(websiteUrl)) {
    throw new Error("Website must start with http:// or https://.");
  }

  return {
    displayName: requireNonEmpty(fields.displayName, "Organizer display name", 140),
    contactName: optionalTrimmed(fields.contactName, 140),
    contactPhone: requireValidGhanaPhone(fields.contactPhone),
    city: requireNonEmpty(fields.city, "City", 80),
    payoutPhone: fields.payoutPhone
      ? requireValidGhanaPhone(fields.payoutPhone)
      : undefined,
    websiteUrl,
    primaryEventType: optionalTrimmed(fields.primaryEventType, 40),
  };
}

// Shared by createEvent/updateEvent - trims and length-bounds every
// free-text field. Client-side forms already discourage garbage input,
// but that's UX only; this is the real gate, since these fields render
// on public event pages and in search results.
function sanitizeEventFields(fields: RawEventFields) {
  // endsAt is what gates organizer payout eligibility (see
  // payouts.ts:initiateOrganizerPayout's cutoff) - without it, eligibility
  // silently falls back to startsAt, meaning revenue could be paid out
  // while the event is still running. Not just a UI nicety, so it's
  // re-checked here rather than trusted from the client.
  if (fields.endsAt !== undefined && fields.endsAt <= fields.startsAt) {
    throw new Error("End time must be after the start time.");
  }

  return {
    title: requireNonEmpty(fields.title, "Event title", 140),
    description: requireNonEmpty(fields.description, "Description", 4000),
    venue: requireNonEmpty(fields.venue, "Venue", 140),
    address: requireNonEmpty(fields.address, "Address", 200),
    city: requireNonEmpty(fields.city, "City", 80),
    startsAt: fields.startsAt,
    endsAt: fields.endsAt,
    slug: eventSlug(fields.title, fields.startsAt),
    heroImageUrl: optionalTrimmed(fields.heroImageUrl, 2000),
    category: requireNonEmpty(fields.category, "Category", 40),
    ageRating: optionalTrimmed(fields.ageRating, 40),
    organizerName: requireNonEmpty(fields.organizerName, "Organizer name", 140),
    organizerSlug: slugify(fields.organizerName),
    venueSlug: slugify(fields.venue),
    organizerPayoutPhone: fields.organizerPayoutPhone
      ? requireValidGhanaPhone(fields.organizerPayoutPhone)
      : undefined,
  };
}

function sanitizeTicketTypeFields(ticketType: RawTicketTypeFields) {
  return {
    name: requireNonEmpty(ticketType.name, "Ticket type name", 80),
    priceGHS: requirePositiveNumber(ticketType.priceGHS, "Price", 100_000),
    quantityTotal: requirePositiveInteger(ticketType.quantityTotal, "Quantity", 100_000),
    quantitySold: 0,
    quantityReserved: 0,
  };
}

function sanitizeTicketTypes(ticketTypes: RawTicketTypeFields[]) {
  if (ticketTypes.length < 1) {
    throw new Error("Add at least one ticket tier.");
  }
  if (ticketTypes.length > 12) {
    throw new Error("Create no more than 12 ticket tiers at a time.");
  }

  return ticketTypes.map(sanitizeTicketTypeFields);
}

// Enforcement point for admin God Mode's organizer suspension
// (setOrganizerTierAdmin's sibling adminSetOrganizerSuspension) - checked
// at creation time only, so a suspended organizer's already-published
// events keep running until an admin individually drafts/cancels them.
async function requireNotSuspended(ctx: MutationCtx, organizerClerkUserId: string) {
  const profile = await ctx.db
    .query("organizerProfiles")
    .withIndex("by_organizer", (q) => q.eq("organizerClerkUserId", organizerClerkUserId))
    .unique();
  if (profile?.suspended) {
    throw new Error(
      "This organizer account is suspended and cannot create new events. Contact support.",
    );
  }
}

export const createEvent = mutation({
  args: eventFields,
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Sign in required to create an event.");
    await requireNotSuspended(ctx, identity.subject);

    return await ctx.db.insert("events", {
      ...sanitizeEventFields(args),
      status: "draft",
      organizerClerkUserId: identity.subject,
      createdAt: Date.now(),
    });
  },
});

export const createEventWithStarterTicket = mutation({
  args: {
    ...eventFields,
    starterTicket: v.object(ticketTypeInput),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Sign in required to create an event.");
    await requireNotSuspended(ctx, identity.subject);
    const [starterTicket] = sanitizeTicketTypes([args.starterTicket]);

    const eventId = await ctx.db.insert("events", {
      ...sanitizeEventFields(args),
      status: "draft",
      organizerClerkUserId: identity.subject,
      createdAt: Date.now(),
    });

    await ctx.db.insert("ticketTypes", {
      eventId,
      ...starterTicket,
    });

    return eventId;
  },
});

export const createEventWithTicketTypes = mutation({
  args: {
    ...eventFields,
    ticketTypes: v.array(v.object(ticketTypeInput)),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Sign in required to create an event.");
    await requireNotSuspended(ctx, identity.subject);
    const ticketTypes = sanitizeTicketTypes(args.ticketTypes);

    const eventId = await ctx.db.insert("events", {
      ...sanitizeEventFields(args),
      status: "draft",
      organizerClerkUserId: identity.subject,
      createdAt: Date.now(),
    });

    for (const ticketType of ticketTypes) {
      await ctx.db.insert("ticketTypes", {
        eventId,
        ...ticketType,
      });
    }

    return eventId;
  },
});

export const updateEvent = mutation({
  args: { eventId: v.id("events"), ...eventFields },
  handler: async (ctx, { eventId, ...fields }) => {
    await requireOwnedEvent(ctx, eventId);
    await ctx.db.patch(eventId, sanitizeEventFields(fields));
  },
});

// Self-serve organizers can only draft/publish. Event cancellation touches
// paid orders and ticket validity, so it lives in the admin ops module.
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
    const ticketType = sanitizeTicketTypeFields(args);
    return await ctx.db.insert("ticketTypes", {
      eventId: args.eventId,
      ...ticketType,
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

    const name = requireNonEmpty(args.name, "Ticket type name", 80);
    const priceGHS = requirePositiveNumber(args.priceGHS, "Price", 100_000);
    const quantityTotal = requirePositiveInteger(args.quantityTotal, "Quantity", 100_000);

    if (quantityTotal < ticketType.quantitySold + ticketType.quantityReserved) {
      throw new Error(
        "Quantity can't be reduced below tickets already sold or reserved.",
      );
    }

    await ctx.db.patch(args.ticketTypeId, { name, priceGHS, quantityTotal });
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
// won't appear in any organizer's dashboard). Admin-gated - this was
// previously a fully public mutation, meaning anyone with the deployment
// URL could spam-create fake events at will.
export const seedDemoEvent = mutation({
  args: { adminSecret: v.string() },
  handler: async (ctx, { adminSecret }) => {
    requireAdminSecret(adminSecret);
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
      const normalizedEvent = sanitizeEventFields(demo.event);
      const eventId = await ctx.db.insert("events", {
        ...normalizedEvent,
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

// Admin-only cleanup for the fake/seeded demo events (no real organizer,
// stock Unsplash photos, placeholder payout phone) - deletes each such
// event along with its ticket types and any orders/tickets against it.
// Real organizer-owned events (organizerClerkUserId set) are untouched.
// Run via `npx convex run events:deleteSeedData '{"adminSecret":"..."}'`.
export const deleteSeedData = mutation({
  args: { adminSecret: v.string() },
  handler: async (ctx, { adminSecret }) => {
    requireAdminSecret(adminSecret);

    const seededEvents = await ctx.db
      .query("events")
      .filter((q) => q.eq(q.field("organizerClerkUserId"), undefined))
      .collect();

    let deletedEvents = 0;
    let deletedTicketTypes = 0;
    let deletedOrders = 0;
    let deletedTickets = 0;

    for (const event of seededEvents) {
      const ticketTypes = await ctx.db
        .query("ticketTypes")
        .withIndex("by_event", (q) => q.eq("eventId", event._id))
        .collect();
      const orders = await ctx.db
        .query("orders")
        .withIndex("by_event", (q) => q.eq("eventId", event._id))
        .collect();
      const tickets = await ctx.db
        .query("tickets")
        .withIndex("by_event", (q) => q.eq("eventId", event._id))
        .collect();

      for (const ticket of tickets) {
        await ctx.db.delete(ticket._id);
        deletedTickets++;
      }
      for (const order of orders) {
        await ctx.db.delete(order._id);
        deletedOrders++;
      }
      for (const ticketType of ticketTypes) {
        await ctx.db.delete(ticketType._id);
        deletedTicketTypes++;
      }
      await ctx.db.delete(event._id);
      deletedEvents++;
    }

    return { deletedEvents, deletedTicketTypes, deletedOrders, deletedTickets };
  },
});
