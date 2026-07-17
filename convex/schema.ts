import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// NSAA TICKETS - Core schema
//
// Design decisions baked into this schema (see project discussion):
// - Tickets are NON-TRANSFERABLE and NON-RESELLABLE. owner is fixed at
//   purchase time. There is no `transfers` table by design.
// - Inventory is RESERVED at checkout start with a timeout, not just
//   deducted on payment confirmation. This prevents overselling during
//   the Mobile Money approval window.
// - QR payloads are signed (HMAC) server-side. The `qrSecret` on each
//   ticket is never sent to the client until the ticket is PAID - the
//   client only ever receives the final signed token, not the secret.
// - All sales are final except for full event cancellation. Service fee
//   is never refunded (matches industry-standard Ticketmaster policy).

export default defineSchema({
  // A single event listing. The platform is intentionally broad:
  // concerts, conferences, sports, weddings, comedy, theatre, religious
  // events, workshops, and other public experiences all use this table.
  events: defineTable({
    title: v.string(),
    description: v.string(),
    venue: v.string(),
    address: v.string(),
    city: v.string(),
    startsAt: v.number(), // unix ms
    endsAt: v.optional(v.number()),
    slug: v.optional(v.string()),
    heroImageUrl: v.optional(v.string()),
    category: v.string(), // "concert" | "nightlife" | "conference" | etc.
    ageRating: v.optional(v.string()),
    status: v.union(
      v.literal("draft"),
      v.literal("published"),
      v.literal("cancelled"),
    ),
    organizerName: v.string(), // display name shown publicly on the event
    organizerSlug: v.optional(v.string()),
    venueSlug: v.optional(v.string()),
    organizerClerkUserId: v.optional(v.string()), // owner for the self-serve dashboard; unset for pre-v1 seeded/manual events
    organizerPayoutPhone: v.optional(v.string()), // Moolre payout target
    createdAt: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_status_category", ["status", "category"])
    .index("by_status_startsAt", ["status", "startsAt"])
    .index("by_status_city_startsAt", ["status", "city", "startsAt"])
    .index("by_status_category_startsAt", ["status", "category", "startsAt"])
    .index("by_slug", ["slug"])
    .index("by_organizer", ["organizerClerkUserId"])
    .index("by_organizer_slug", ["organizerSlug"])
    .index("by_venue_slug", ["venueSlug"]),

  // A purchasable tier within an event, e.g. "Regular", "VIP".
  ticketTypes: defineTable({
    eventId: v.id("events"),
    name: v.string(),
    priceGHS: v.number(), // ticket price only, in GHS, service fee is separate
    quantityTotal: v.number(),
    quantitySold: v.number(), // confirmed, paid
    quantityReserved: v.number(), // held during checkout, not yet paid
  }).index("by_event", ["eventId"]),

  // One checkout attempt. An order can produce multiple tickets
  // (quantity > 1) but they all share one payment.
  orders: defineTable({
    eventId: v.id("events"),
    ticketTypeId: v.id("ticketTypes"),
    quantity: v.number(),

    buyerName: v.string(),
    buyerPhone: v.string(), // MoMo number, also identity for guest checkout
    buyerEmail: v.string(), // required - the ticket receipt (with QR codes) is emailed here
    clerkUserId: v.optional(v.string()), // set if buyer is signed in
    referralCode: v.optional(v.string()), // organizer/promoter attribution from event links

    ticketSubtotalGHS: v.number(), // priceGHS * quantity
    serviceFeeGHS: v.number(), // NON-REFUNDABLE, always retained
    totalGHS: v.number(),

    status: v.union(
      v.literal("reserved"), // inventory held, awaiting payment
      v.literal("paid"),
      v.literal("expired"), // reservation timed out, inventory released
      v.literal("failed"), // Moolre payment failed
      v.literal("refunded"), // event was cancelled
    ),

    reservedUntil: v.number(), // unix ms - scheduled function sweeps past this

    moolreReference: v.optional(v.string()), // Moolre's transaction id
    moolreExternalRef: v.optional(v.string()), // exact externalref sent to Moolre for the active attempt
    moolreStatus: v.optional(v.string()), // raw status from Moolre webhook
    // Human-readable reason from Moolre's own response when a request is
    // rejected at initiation (e.g. bad credentials, insufficient balance,
    // unsupported channel) - moolreReference only holds a machine code in
    // that case, so this is what lets the buyer/support see *why* instead
    // of just a generic "payment did not start".
    moolreFailureReason: v.optional(v.string()),

    createdAt: v.number(),
    paidAt: v.optional(v.number()),

    // Admin God Mode: a real Moolre transfer back to the buyer, the
    // deliberate/audited exception to "all sales final" (see
    // convex/ordersAdmin.ts). Mirrors the pending->paid verification
    // rigor payouts.ts uses for organizer payouts - never assume the
    // transfer succeeded until Moolre's own status endpoint confirms it,
    // so `status` only flips to "refunded" once refundStatus is "paid".
    refundStatus: v.optional(
      v.union(v.literal("pending"), v.literal("paid"), v.literal("failed")),
    ),
    refundAmountGHS: v.optional(v.number()),
    refundReason: v.optional(v.string()),
    refundExternalRef: v.optional(v.string()),
    refundMoolreReference: v.optional(v.string()),
    refundInitiatedByAdminId: v.optional(v.string()),
    refundedAt: v.optional(v.number()),
  })
    // No standalone by_status index - by_reserved_until's leading column
    // (status) already serves pure status-equality lookups as a prefix,
    // so a separate index would just add write overhead for no read
    // benefit. No by_moolre_reference either - the Moolre webhook/status
    // rewrite looks orders up directly by _id (parsed from the
    // order:<id> externalref), never by searching this field.
    .index("by_reserved_until", ["status", "reservedUntil"])
    .index("by_clerk_user", ["clerkUserId"])
    .index("by_event", ["eventId"]),

  // One scannable ticket. quantity > 1 orders produce N of these rows,
  // each with its own independent QR code, so a group can be scanned in
  // individually rather than all-or-nothing at the gate.
  tickets: defineTable({
    orderId: v.id("orders"),
    eventId: v.id("events"),
    ticketTypeId: v.id("ticketTypes"),

    ownerName: v.string(),
    ownerPhone: v.string(),

    // Signed payload components. The actual QR encodes a token built from
    // these plus an HMAC signature computed server-side - see
    // convex/tickets.ts:generateSignedToken. Never trust a client-supplied
    // signature; always recompute and compare server-side on scan.
    qrToken: v.string(), // the full signed token embedded in the QR image
    seatLabel: v.optional(v.string()),

    status: v.union(
      v.literal("pending"), // order not yet paid
      v.literal("valid"), // paid, not yet scanned
      v.literal("used"), // scanned at the gate
      v.literal("void"), // event cancelled or order refunded
    ),

    usedAt: v.optional(v.number()),
    scannedBy: v.optional(v.string()), // door staff identifier, optional

    createdAt: v.number(),
  })
    // No by_qr_token index - validateScan looks a ticket up by its _id
    // (the first segment of the token), never by searching for a token
    // value, so this would just add write overhead with no read benefit.
    .index("by_order", ["orderId"])
    .index("by_event", ["eventId"]),

  organizerInquiries: defineTable({
    organizerName: v.string(),
    contactName: v.string(),
    phone: v.string(),
    email: v.optional(v.string()),
    supportNeeds: v.optional(v.array(v.string())),
    websiteUrl: v.optional(v.string()),
    payoutReadiness: v.optional(v.string()),
    message: v.string(),
    status: v.union(
      v.literal("new"),
      v.literal("contacted"),
      v.literal("closed"),
    ),
    createdAt: v.number(),
  }).index("by_status", ["status"]),

  // General "Contact us" submissions - support/press/general questions.
  // Distinct from organizerInquiries, which is specifically the
  // list-your-event lead form.
  contactMessages: defineTable({
    name: v.string(),
    email: v.string(),
    topic: v.union(
      v.literal("support"),
      v.literal("payments"),
      v.literal("press"),
      v.literal("partnerships"),
      v.literal("other"),
    ),
    message: v.string(),
    status: v.union(
      v.literal("new"),
      v.literal("contacted"),
      v.literal("closed"),
    ),
    createdAt: v.number(),
  }).index("by_status", ["status"]),

  // Footer newsletter signup. Deliberately minimal - no campaign/segment
  // fields, just enough to capture an email once.
  newsletterSubscribers: defineTable({
    email: v.string(),
    createdAt: v.number(),
  }).index("by_email", ["email"]),

  // Self-serve organizer pricing tier (see convex/events.ts). One profile per Clerk user -
  // applies to every event that organizer runs, not chosen per event.
  // No profile (legacy/seeded events, or an organizer who never picked a
  // plan) falls back to the "essential" rate - see feePercentForTier.
  organizerProfiles: defineTable({
    organizerClerkUserId: v.string(),
    tier: v.union(
      v.literal("free"), // 0% - non-ticketed/free events only in practice, since fee only ever applies to paid tickets anyway
      v.literal("essential"),
      v.literal("pro"),
      v.literal("custom"), // admin-assigned only, not self-serve
    ),
    displayName: v.optional(v.string()),
    contactName: v.optional(v.string()),
    contactEmail: v.optional(v.string()),
    contactPhone: v.optional(v.string()),
    city: v.optional(v.string()),
    payoutPhone: v.optional(v.string()),
    websiteUrl: v.optional(v.string()),
    primaryEventType: v.optional(v.string()),
    onboardingCompletedAt: v.optional(v.number()),
    createdAt: v.optional(v.number()),
    customFeePercent: v.optional(v.number()), // only meaningful for "custom"
    updatedAt: v.number(),
    // Admin God Mode: blocks self-serve event creation for this organizer
    // (convex/events.ts createEvent/createEventWithStarterTicket/
    // createEventWithTicketTypes) without touching their already-published
    // events, which an admin can still draft/cancel individually.
    suspended: v.optional(v.boolean()),
    suspendedReason: v.optional(v.string()),
    suspendedAt: v.optional(v.number()),
  }).index("by_organizer", ["organizerClerkUserId"]),

  // Organizer payout ledger (the "escrow" model). Ticket revenue for an
  // event isn't paid out to the organizer until the event's end date has
  // passed and an admin explicitly triggers it (see convex/payouts.ts) -
  // this table is what makes that a real accounting record rather than a
  // one-off wire transfer with no trail. amountGHS is the organizer's cut
  // only (ticketSubtotalGHS sum) - the service fee is always retained by
  // the platform and never appears here.
  payouts: defineTable({
    eventId: v.id("events"),
    organizerPayoutPhone: v.string(), // snapshotted at payout time
    amountGHS: v.number(),
    status: v.union(
      v.literal("pending"), // transfer accepted by Moolre, awaiting confirmation
      v.literal("paid"),
      v.literal("failed"),
    ),
    moolreReference: v.optional(v.string()), // Moolre's transactionid once confirmed
    createdAt: v.number(),
    paidAt: v.optional(v.number()),
  }).index("by_event", ["eventId"]),

  // Public, reusable venue profile pages. Events can keep working without
  // a linked venue row; venueSlug on events lets us derive profile pages
  // from existing listings until a formal venue record exists.
  venueProfiles: defineTable({
    slug: v.string(),
    name: v.string(),
    city: v.string(),
    address: v.optional(v.string()),
    description: v.optional(v.string()),
    heroImageUrl: v.optional(v.string()),
    mapUrl: v.optional(v.string()),
    verifiedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_city", ["city"]),

  // Public organizer profile pages, separate from billing/pricing profile.
  organizerPublicProfiles: defineTable({
    slug: v.string(),
    displayName: v.string(),
    organizerClerkUserId: v.optional(v.string()),
    description: v.optional(v.string()),
    websiteUrl: v.optional(v.string()),
    logoUrl: v.optional(v.string()),
    verifiedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_organizer", ["organizerClerkUserId"]),

  scannerStaff: defineTable({
    eventId: v.id("events"),
    name: v.string(),
    gateLabel: v.string(),
    role: v.union(v.literal("scanner"), v.literal("lead")),
    tokenHash: v.string(),
    tokenPreview: v.string(),
    status: v.union(v.literal("active"), v.literal("revoked")),
    createdByClerkUserId: v.optional(v.string()),
    createdAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_event", ["eventId"])
    .index("by_token_hash", ["tokenHash"]),

  scanLogs: defineTable({
    eventId: v.optional(v.id("events")),
    ticketId: v.optional(v.id("tickets")),
    scannerStaffId: v.optional(v.id("scannerStaff")),
    gateLabel: v.optional(v.string()),
    scannedBy: v.optional(v.string()),
    outcome: v.union(v.literal("accepted"), v.literal("rejected")),
    reason: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_event", ["eventId"])
    .index("by_scanner", ["scannerStaffId"]),

  // Admin God Mode: every override action (force-paid, refund, void,
  // reissue, unscan, suspend, block, payout override, ...) writes one row
  // here so it's attributable to a real signed-in admin (see
  // convex/admin.ts requireAdmin/logAdminAction) instead of vanishing into
  // an untraceable shared-secret call.
  adminAuditLog: defineTable({
    adminClerkUserId: v.string(),
    adminLabel: v.string(), // name/email snapshot at action time, for display even if the account changes later
    action: v.string(), // e.g. "order.forcePaid", "ticket.void", "event.cancel"
    targetType: v.string(), // "order" | "ticket" | "event" | "payout" | "organizerProfile" | "buyerBlocklist"
    targetId: v.string(),
    reason: v.optional(v.string()),
    detailsJson: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_created", ["createdAt"])
    .index("by_target", ["targetType", "targetId"]),

  // Admin God Mode: blocks new guest-checkout reservations from a phone
  // number or email (convex/orders.ts createReservation). Deliberately
  // separate from any user-account table since guest checkout has no
  // account to suspend - this is the only handle available on a bad actor.
  buyerBlocklist: defineTable({
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
    reason: v.string(),
    createdAt: v.number(),
    createdByAdminId: v.string(),
  })
    .index("by_phone", ["phone"])
    .index("by_email", ["email"]),

  // One-time post-signup survey (public/welcome.html) - every fresh Clerk
  // sign-in/sign-up passes through that page, which no-ops immediately if
  // a row already exists here for that user, so this only ever prompts a
  // given account once. `skipped` still counts as "asked" so declining
  // doesn't nag the user again on their next session.
  userOnboarding: defineTable({
    clerkUserId: v.string(),
    referralSource: v.optional(v.string()),
    role: v.optional(v.string()),
    skipped: v.optional(v.boolean()),
    completedAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_clerk_user", ["clerkUserId"]),
});
