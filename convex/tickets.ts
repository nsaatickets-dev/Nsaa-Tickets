import { mutation, query, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { requireAdminSecret } from "./admin";

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

// The core anti-fraud mutation: scan a QR token at the gate.
// Convex mutations run transactionally, so two door-staff devices
// scanning the same screenshotted code within the same second cannot
// both succeed - whichever mutation commits first wins, the second
// reliably sees status "used" and is rejected.
export const validateScan = mutation({
  args: { qrToken: v.string(), scannedBy: v.optional(v.string()) },
  handler: async (ctx, { qrToken, scannedBy }) => {
    const [ticketId, expiryStr, signature] = qrToken.split(".");
    if (!ticketId || !expiryStr || !signature) {
      return { ok: false, reason: "Malformed code" };
    }

    const secret = process.env.QR_SIGNING_SECRET;
    if (!secret) {
      return { ok: false, reason: "Scanner misconfigured" };
    }

    const expectedSignature = await hmacSign(
      `${ticketId}.${expiryStr}`,
      secret,
    );
    if (expectedSignature !== signature) {
      return { ok: false, reason: "Invalid ticket - signature mismatch" };
    }

    if (Date.now() > Number(expiryStr)) {
      return { ok: false, reason: "Ticket expired" };
    }

    const ticket = await ctx.db.get(ticketId as any);
    if (!ticket) {
      return { ok: false, reason: "Ticket not found" };
    }

    if (ticket.status === "used") {
      return {
        ok: false,
        reason: `Already used at ${new Date(ticket.usedAt ?? 0).toLocaleString()}`,
      };
    }

    if (ticket.status === "void") {
      return { ok: false, reason: "Ticket voided (event cancelled)" };
    }

    if (ticket.status !== "valid") {
      return { ok: false, reason: `Ticket is ${ticket.status}` };
    }

    await ctx.db.patch(ticket._id, {
      status: "used",
      usedAt: Date.now(),
      scannedBy,
    });

    return {
      ok: true,
      ownerName: ticket.ownerName,
      ticketTypeId: ticket.ticketTypeId,
    };
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
