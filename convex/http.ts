import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const http = httpRouter();

// Moolre calls this endpoint when a payment or transfer's status changes.
// Verified against docs.moolre.com (Payment Webhook): POST body shape is
// { status, code, message, data: { externalref, transactionid, ... } }.
// Moolre's docs don't document a signature/verification header, so this
// handler doesn't trust the body's status at all - it only uses
// `data.externalref` to know which record to re-check, then verifies the
// real status via Moolre's own status endpoint (see
// convex/moolre.ts:verifyAndProcessPayment and
// convex/payouts.ts:verifyAndProcessPayout).
//
// One webhook URL handles both customer payments (collections) and
// organizer payouts (transfers) - Moolre registers one callback per
// account, not per transaction type - so externalref is always sent as
// `order:<id>` or `payout:<id>` (see orders.ts / payouts.ts) and routed
// here based on that prefix.
//
// This URL must be registered as the account's webhook/callback URL in
// the Moolre dashboard (or via POST /open/account/update's `callback`
// field) - Moolre has no per-request callback field.
http.route({
  path: "/moolre/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json();
    const externalref: string | undefined = body?.data?.externalref;

    if (!externalref) {
      return new Response("Missing data.externalref", { status: 400 });
    }

    const [prefix = "", id = ""] = externalref.split(":");

    if (prefix === "order" && id) {
      await ctx.runAction(internal.moolre.verifyAndProcessPayment, {
        externalref,
        orderId: id as Id<"orders">,
      });
    } else if (prefix === "payout" && id) {
      await ctx.runAction(internal.payouts.verifyAndProcessPayout, {
        externalref,
        payoutId: id as Id<"payouts">,
      });
    } else {
      console.error(`Unrecognized Moolre externalref format: ${externalref}`);
      return new Response("Unrecognized externalref", { status: 400 });
    }

    return new Response("ok", { status: 200 });
  }),
});

// Serves a ticket's QR code as a real fetchable PNG, so the confirmation
// email (convex/moolre.ts:sendConfirmation) can use a normal <img
// src="..."> instead of an inline base64 data: URI - Gmail strips inline
// data: image URIs from HTML email, so a hosted URL is the only approach
// that renders everywhere. Generation happens on-demand (not cached in
// storage) since a ticket's token never changes once issued.
http.route({
  path: "/tickets/qr",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const ticketId = url.searchParams.get("ticketId");
    if (!ticketId) {
      return new Response("Missing ticketId", { status: 400 });
    }

    const ticket = await ctx.runQuery(internal.tickets.getTicketInternal, {
      ticketId: ticketId as Id<"tickets">,
    });
    if (!ticket) {
      return new Response("Not found", { status: 404 });
    }

    const base64: string = await ctx.runAction(internal.qrImage.tokenToPngBase64, {
      token: ticket.qrToken,
    });
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  }),
});

export default http;
