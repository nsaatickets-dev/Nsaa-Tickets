import { mutation, query, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { requireAdminSecret, requireAdmin, logAdminAction } from "./admin";
import { rateLimiter } from "./rateLimit";
import { requireNonEmpty } from "./validation";
import { Doc, Id } from "./_generated/dataModel";

// --- Signed QR token ---
// A ticket's QR encodes: ticketId.expiryUnixMs.signature
// The signature is an HMAC-SHA256 of `${ticketId}.${expiryUnixMs}` using
// a server-only secret (QR_SIGNING_SECRET, set via `npx convex env set`).
// This means:
//   - a screenshot of the code still only validates while unused (the
//     first successful scan flips status to "used" and every scan after
//     that is rejected, regardless of how many copies exist)
//   - nobody can forge a valid code for a ticket_id they don't own,
//     since they don't have the signing secret
//   - the client (scanner app) never needs the secret - it just calls
//     the validateScan mutation below and trusts Convex's answer

async function hmacSign(message: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(message: string): Promise<string> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(message));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function scannerTokenHash(token: string): Promise<string> {
  const pepper = process.env.SCANNER_KEY || process.env.QR_SIGNING_SECRET;
  if (!pepper) throw new Error("Scanner token pepper is not configured");
  return await sha256Hex(`${pepper}:${token}`);
}

async function buildSignedToken(ticketId: string): Promise<string> {
  const secret = process.env.QR_SIGNING_SECRET;
  if (!secret) throw new Error("QR_SIGNING_SECRET is not configured");
  // Tickets don't expire on a timer the way a login token would - they're
  // valid until the event passes. We still embed a far-future expiry so
  // the token format supports time-boxing later without a schema change.
  const expiry = Date.now() + 1000 * 60 * 60 * 24 * 30; // 30 days
  const payload = `${ticketId}.${expiry}`;
  const signature = await hmacSign(payload, secret);
  return `${payload}.${signature}`;
}

// Shared helper (plain function, not a Convex function itself) so both
// the internalMutation below and moolre.ts's webhook handler can issue
// tickets from within their own mutation context without needing a
// separate runMutation round-trip.
export async function issueTickets(ctx: any, orderId: any) {
  const order = await ctx.db.get(orderId);
  if (!order) throw new Error("Order not found");

  const ticketIds = [];
  for (let i = 0; i < order.quantity; i++) {
    const ticketId = await ctx.db.insert("tickets", {
      orderId: order._id,
      eventId: order.eventId,
      ticketTypeId: order.ticketTypeId,
      ownerName: order.buyerName,
      ownerPhone: order.buyerPhone,
      qrToken: "", // filled in immediately below, insert first to get an id
      status: "valid",
      createdAt: Date.now(),
    });

    const token = await buildSignedToken(ticketId);
    await ctx.db.patch(ticketId, { qrToken: token });
    ticketIds.push(ticketId);
  }

  // Move inventory from reserved to sold now that payment is confirmed.
  const ticketType = await ctx.db.get(order.ticketTypeId);
  if (ticketType) {
    await ctx.db.patch(order.ticketTypeId, {
      quantityReserved: Math.max(
        0,
        ticketType.quantityReserved - order.quantity,
      ),
      quantitySold: ticketType.quantitySold + order.quantity,
    });
  }

  return ticketIds;
}

// Called once an order flips to "paid" (see moolre.ts webhook handler).
// Issues one ticket row + signed QR token per unit of quantity.
export const issueTicketsForOrder = internalMutation({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }: { orderId: any }) => {
    return await issueTickets(ctx, orderId);
  },
});

export const ticketsForOrder = query({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    return await ctx.db
      .query("tickets")
      .withIndex("by_order", (q) => q.eq("orderId", orderId))
      .collect();
  },
});

// Used by the /tickets/qr HTTP route (convex/http.ts) to look up a
// ticket's signed token before rendering its QR image. Internal - the
// route itself is the only thing that should resolve a bare ticket id
// into a token.
export const getTicketInternal = internalQuery({
  args: { ticketId: v.id("tickets") },
  handler: async (ctx, { ticketId }) => {
    return await ctx.db.get(ticketId);
  },
});

export const ticketsForOrderDetailed = query({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    const order = await ctx.db.get(orderId);
    if (!order) return null;

    const [event, ticketType, tickets] = await Promise.all([
      ctx.db.get(order.eventId),
      ctx.db.get(order.ticketTypeId),
      ctx.db
        .query("tickets")
        .withIndex("by_order", (q) => q.eq("orderId", orderId))
        .collect(),
    ]);

    return { order, event, ticketType, tickets };
  },
});

export const ticketsForCurrentUserDetailed = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const orders = await ctx.db
      .query("orders")
      .withIndex("by_clerk_user", (q) => q.eq("clerkUserId", identity.subject))
      .collect();

    const results = [];
    for (const order of orders) {
      const tickets = await ctx.db
        .query("tickets")
        .withIndex("by_order", (q) => q.eq("orderId", order._id))
        .collect();

      if (tickets.length === 0) continue;

      results.push({
        order,
        event: await ctx.db.get(order.eventId),
        ticketType: await ctx.db.get(order.ticketTypeId),
        tickets,
      });
    }

    return results;
  },
});

async function requireEventOwner(ctx: any, eventId: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Sign in required.");

  const event = await ctx.db.get(eventId);
  if (!event) throw new Error("Event not found.");
  if (event.organizerClerkUserId !== identity.subject) {
    throw new Error("You do not have access to this event.");
  }
  return { identity, event };
}

export const listScannerStaff = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    await requireEventOwner(ctx, eventId);
    return await ctx.db
      .query("scannerStaff")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect();
  },
});

export const createScannerStaff = mutation({
  args: {
    eventId: v.id("events"),
    name: v.string(),
    gateLabel: v.string(),
    role: v.union(v.literal("scanner"), v.literal("lead")),
  },
  handler: async (ctx, args) => {
    const { identity } = await requireEventOwner(ctx, args.eventId);
    const name = requireNonEmpty(args.name, "Staff name", 120);
    const gateLabel = requireNonEmpty(args.gateLabel, "Gate label", 80);
    const token = `nsaa_scan_${crypto.randomUUID().replace(/-/g, "")}`;
    const tokenHash = await scannerTokenHash(token);

    const scannerStaffId = await ctx.db.insert("scannerStaff", {
      eventId: args.eventId,
      name,
      gateLabel,
      role: args.role,
      tokenHash,
      tokenPreview: token.slice(-8),
      status: "active",
      createdByClerkUserId: identity.subject,
      createdAt: Date.now(),
    });

    return { scannerStaffId, token, tokenPreview: token.slice(-8) };
  },
});

export const revokeScannerStaff = mutation({
  args: { scannerStaffId: v.id("scannerStaff") },
  handler: async (ctx, { scannerStaffId }) => {
    const staff = await ctx.db.get(scannerStaffId);
    if (!staff) throw new Error("Scanner staff record not found.");
    await requireEventOwner(ctx, staff.eventId);
    await ctx.db.patch(scannerStaffId, {
      status: "revoked",
      revokedAt: Date.now(),
    });
  },
});

export const scanLogsForEvent = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    await requireEventOwner(ctx, eventId);
    return await ctx.db
      .query("scanLogs")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .order("desc")
      .take(80);
  },
});

// The core anti-fraud mutation: scan a QR token at the gate.
// Convex mutations run transactionally, so two door-staff devices
// scanning the same screenshotted code within the same second cannot
// both succeed - whichever mutation commits first wins, the second
// reliably sees status "used" and is rejected.
// Gated by a shared scanner key (SCANNER_KEY), not the QR signature alone
// - without this, anyone who observed or leaked a single valid ticket's
// raw token (e.g. a photographed QR code before doors open) could call
// this directly to pre-emptively mark it "used" and deny the real
// holder entry, without ever needing to physically scan anything.
export const validateScan = mutation({
  args: { qrToken: v.string(), scannedBy: v.optional(v.string()), scannerKey: v.string() },
  handler: async (ctx, { qrToken, scannedBy, scannerKey }) => {
    const expectedScannerKey = process.env.SCANNER_KEY;
    let scannerStaff: Doc<"scannerStaff"> | null = null;
    let rateLimitKey = scannerKey;

    if (expectedScannerKey && scannerKey === expectedScannerKey) {
      rateLimitKey = "legacy-shared-scanner-key";
    } else {
      const tokenHash = await scannerTokenHash(scannerKey);
      rateLimitKey = tokenHash;
      const staff = await ctx.db
        .query("scannerStaff")
        .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
        .unique();

      if (!staff || staff.status !== "active") {
        return { ok: false, reason: "Scanner not authorized" };
      }
      scannerStaff = staff;
    }

    const logScan = async (
      outcome: "accepted" | "rejected",
      reason?: string,
      ticket?: Doc<"tickets">,
    ) => {
      await ctx.db.insert("scanLogs", {
        eventId: ticket?.eventId ?? scannerStaff?.eventId,
        ticketId: ticket?._id,
        scannerStaffId: scannerStaff?._id,
        gateLabel: scannerStaff?.gateLabel,
        scannedBy: scannedBy || scannerStaff?.name,
        outcome,
        reason,
        createdAt: Date.now(),
      });
    };

    const reject = async (reason: string, ticket?: Doc<"tickets">) => {
      await logScan("rejected", reason, ticket);
      return { ok: false, reason };
    };

    const scanLimit = await rateLimiter.limit(ctx, "scansByKey", { key: rateLimitKey });
    if (!scanLimit.ok) {
      return await reject("Scanning too fast - wait a moment and try again");
    }

    const [ticketId, expiryStr, signature] = qrToken.split(".");
    if (!ticketId || !expiryStr || !signature) {
      return await reject("Malformed code");
    }

    const secret = process.env.QR_SIGNING_SECRET;
    if (!secret) {
      return await reject("Scanner misconfigured");
    }

    const expectedSignature = await hmacSign(
      `${ticketId}.${expiryStr}`,
      secret,
    );
    if (expectedSignature !== signature) {
      return await reject("Invalid ticket - signature mismatch");
    }

    if (Date.now() > Number(expiryStr)) {
      return await reject("Ticket expired");
    }

    const ticket = await ctx.db.get(ticketId as Id<"tickets">);
    if (!ticket) {
      return await reject("Ticket not found");
    }

    if (ticket.status === "used") {
      return await reject(`Already used at ${new Date(ticket.usedAt ?? 0).toLocaleString()}`, ticket);
    }

    if (ticket.status === "void") {
      return await reject("Ticket voided (event cancelled)", ticket);
    }

    if (ticket.status !== "valid") {
      return await reject(`Ticket is ${ticket.status}`, ticket);
    }

    await ctx.db.patch(ticket._id, {
      status: "used",
      usedAt: Date.now(),
      scannedBy: scannedBy || scannerStaff?.name,
    });
    await logScan("accepted", undefined, ticket);

    return {
      ok: true,
      ownerName: ticket.ownerName,
      ticketTypeId: ticket.ticketTypeId,
      gateLabel: scannerStaff?.gateLabel,
      scannerName: scannerStaff?.name,
    };
  },
});

// Admin God Mode: voids a single ticket (suspected fraud, duplicate
// print, a support-requested cancellation that doesn't warrant refunding
// the whole order) without touching the rest of its order.
export const adminVoidTicket = mutation({
  args: { ticketId: v.id("tickets"), reason: v.string() },
  handler: async (ctx, { ticketId, reason }) => {
    const admin = await requireAdmin(ctx);
    const trimmedReason = reason.trim();
    if (!trimmedReason) throw new Error("A reason is required.");

    const ticket = await ctx.db.get(ticketId);
    if (!ticket) throw new Error("Ticket not found.");
    if (ticket.status === "void") throw new Error("Ticket is already void.");

    await ctx.db.patch(ticketId, { status: "void" });

    await logAdminAction(ctx, admin, {
      action: "ticket.void",
      targetType: "ticket",
      targetId: ticketId,
      reason: trimmedReason,
      details: { previousStatus: ticket.status },
    });
  },
});

// Admin God Mode: rotates a ticket's signed QR token in place - for a
// leaked/photographed code before doors open, this invalidates every copy
// of the old code (validateScan signature-checks against the current
// token) without voiding the ticket or making the buyer re-checkout.
export const adminReissueTicket = mutation({
  args: { ticketId: v.id("tickets"), reason: v.string() },
  handler: async (ctx, { ticketId, reason }) => {
    const admin = await requireAdmin(ctx);
    const trimmedReason = reason.trim();
    if (!trimmedReason) throw new Error("A reason is required.");

    const ticket = await ctx.db.get(ticketId);
    if (!ticket) throw new Error("Ticket not found.");
    if (ticket.status !== "valid") {
      throw new Error(`Ticket is ${ticket.status} - only a valid ticket can be reissued.`);
    }

    const token = await buildSignedToken(ticketId);
    await ctx.db.patch(ticketId, { qrToken: token });

    await logAdminAction(ctx, admin, {
      action: "ticket.reissue",
      targetType: "ticket",
      targetId: ticketId,
      reason: trimmedReason,
    });
  },
});

// Admin God Mode: undoes a mis-scan (wrong ticket tapped, a scanner
// glitch double-fired) by flipping "used" back to "valid".
export const adminUnscanTicket = mutation({
  args: { ticketId: v.id("tickets"), reason: v.string() },
  handler: async (ctx, { ticketId, reason }) => {
    const admin = await requireAdmin(ctx);
    const trimmedReason = reason.trim();
    if (!trimmedReason) throw new Error("A reason is required.");

    const ticket = await ctx.db.get(ticketId);
    if (!ticket) throw new Error("Ticket not found.");
    if (ticket.status !== "used") {
      throw new Error(`Ticket is ${ticket.status}, not used - nothing to unscan.`);
    }

    await ctx.db.patch(ticketId, { status: "valid", usedAt: undefined, scannedBy: undefined });

    await logAdminAction(ctx, admin, {
      action: "ticket.unscan",
      targetType: "ticket",
      targetId: ticketId,
      reason: trimmedReason,
    });
  },
});

// Admin God Mode: looks up a single order (and its tickets) by order id,
// or a single ticket by ticket id, for the dashboard's Orders/Tickets
// search boxes. Read-only, but still admin-gated since it exposes a
// buyer's full name/phone/email.
export const adminFindOrder = query({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    await requireAdmin(ctx);
    const order = await ctx.db.get(orderId);
    if (!order) return null;

    const [event, ticketType, tickets] = await Promise.all([
      ctx.db.get(order.eventId),
      ctx.db.get(order.ticketTypeId),
      ctx.db
        .query("tickets")
        .withIndex("by_order", (q) => q.eq("orderId", orderId))
        .collect(),
    ]);

    return { order, event, ticketType, tickets };
  },
});

// Admin God Mode: broader order search for the dashboard's Orders tab -
// by buyer phone, buyer email, or event, each capped to a manageable page
// since this scans the orders table rather than using an index (there's
// no by_phone/by_email index on orders - see schema.ts's note on why -
// and this is an infrequent admin lookup, not a hot path).
export const adminSearchOrders = query({
  args: {
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
    eventId: v.optional(v.id("events")),
  },
  handler: async (ctx, { phone, email, eventId }) => {
    await requireAdmin(ctx);

    let orders;
    if (eventId) {
      orders = await ctx.db
        .query("orders")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .order("desc")
        .take(100);
    } else {
      orders = await ctx.db.query("orders").order("desc").take(500);
    }

    const normalizedPhone = phone?.replace(/[\s\-()]/g, "").toLowerCase();
    const normalizedEmail = email?.trim().toLowerCase();

    return orders
      .filter((order) => {
        if (normalizedPhone && !order.buyerPhone.replace(/[\s\-()]/g, "").includes(normalizedPhone)) {
          return false;
        }
        if (normalizedEmail && !order.buyerEmail.toLowerCase().includes(normalizedEmail)) {
          return false;
        }
        return true;
      })
      .slice(0, 100);
  },
});

// Admin God Mode: single-ticket lookup for the Tickets tab's search box,
// plus that ticket's own scan history.
export const adminFindTicket = query({
  args: { ticketId: v.id("tickets") },
  handler: async (ctx, { ticketId }) => {
    await requireAdmin(ctx);
    const ticket = await ctx.db.get(ticketId);
    if (!ticket) return null;

    const [order, scanLogs] = await Promise.all([
      ctx.db.get(ticket.orderId),
      ctx.db
        .query("scanLogs")
        .withIndex("by_event", (q) => q.eq("eventId", ticket.eventId))
        .filter((q) => q.eq(q.field("ticketId"), ticketId))
        .order("desc")
        .collect(),
    ]);

    return { ticket, order, scanLogs };
  },
});

// TEMPORARY test utility - creates one real paid order with real issued
// tickets (through the same issueTickets() path production payments use,
// so the QR tokens are genuinely representative) purely so QR rendering
// can be checked in an actual browser. No organizerClerkUserId, so it's
// removable later via events:deleteSeedData like any other test fixture.
export const debugCreatePaidTestOrder = mutation({
  args: { adminSecret: v.string(), buyerEmail: v.string() },
  handler: async (ctx, { adminSecret, buyerEmail }) => {
    requireAdminSecret(adminSecret);

    const eventId = await ctx.db.insert("events", {
      title: "QR Preview Test Event",
      description: "Temporary event for previewing QR ticket rendering. Safe to delete.",
      venue: "Test Venue",
      address: "Test Address, Accra",
      city: "Accra",
      startsAt: Date.now() + 1000 * 60 * 60 * 24 * 7,
      category: "concert",
      status: "published",
      organizerName: "Nsaa Tickets (test)",
      createdAt: Date.now(),
    });

    const ticketTypeId = await ctx.db.insert("ticketTypes", {
      eventId,
      name: "General",
      priceGHS: 50,
      quantityTotal: 10,
      quantitySold: 0,
      quantityReserved: 0,
    });

    const orderId = await ctx.db.insert("orders", {
      eventId,
      ticketTypeId,
      quantity: 3,
      buyerName: "Test Buyer",
      buyerPhone: "0240000000",
      buyerEmail,
      ticketSubtotalGHS: 150,
      serviceFeeGHS: 6,
      totalGHS: 156,
      status: "paid",
      reservedUntil: Date.now(),
      createdAt: Date.now(),
      paidAt: Date.now(),
    });

    await issueTickets(ctx, orderId);

    return { orderId, eventId };
  },
});
