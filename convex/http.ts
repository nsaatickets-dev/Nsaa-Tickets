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

    const separatorIndex = externalref.indexOf(":");
    const prefix = separatorIndex === -1 ? "" : externalref.slice(0, separatorIndex);
    const id = separatorIndex === -1 ? "" : externalref.slice(separatorIndex + 1);

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

export default http;
