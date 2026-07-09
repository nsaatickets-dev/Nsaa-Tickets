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
    heroImageUrl: v.optional(v.string()),
    category: v.string(), // "concert" | "nightlife" | "conference" | etc.
    status: v.union(
      v.literal("draft"),
      v.literal("published"),
      v.literal("cancelled"),
    ),
    organizerName: v.string(), // display name shown publicly on the event
    organizerClerkUserId: v.optional(v.string()), // owner for the self-serve dashboard; unset for pre-v1 seeded/manual events
    organizerPayoutPhone: v.optional(v.string()), // Moolre payout target
    createdAt: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_status_category", ["status", "category"])
    .index("by_organizer", ["organizerClerkUserId"]),

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
    moolreStatus: v.optional(v.string()), // raw status from Moolre webhook

    createdAt: v.number(),
    paidAt: v.optional(v.number()),
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
    eventType: v.string(),
    eventCity: v.string(),
    expectedAttendance: v.optional(v.number()),
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

  // Self-serve organizer pricing tier (see convex/events.ts and
  // convex/orders.ts:computeServiceFee). One profile per Clerk user -
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
    customFeePercent: v.optional(v.number()), // only meaningful for "custom"
    updatedAt: v.number(),
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
});
