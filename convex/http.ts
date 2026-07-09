import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

// Moolre calls this endpoint when a payment's status changes (success,
// failure, etc). Confirm the exact payload shape and header-based
// signature verification scheme against Moolre's real webhook docs
// before going live - this handler assumes a JSON body with a
// `reference` field matching the order id we sent at payment initiation,
// and a `status` field. Treat this as a structural starting point, not a
// verified-against-the-real-API implementation.
http.route({
  path: "/moolre/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    // TODO: verify Moolre's webhook signature header here before trusting
    // the body, once you have their signing scheme from the dashboard.
    const body = await request.json();

    const reference = body.reference;
    const status = body.status;

    if (!reference) {
      return new Response("Missing reference", { status: 400 });
    }

    await ctx.runMutation(internal.moolre.handleWebhookEvent, {
      moolreReference: reference,
      status,
    });

    return new Response("ok", { status: 200 });
  }),
});

export default http;
