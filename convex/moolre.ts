import { internalMutation, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { issueTickets } from "./tickets";

// Called from convex/http.ts when Moolre POSTs a payment status update.
// This is the single place that flips an order from "reserved" to
// "paid" - never trust the client to report its own payment success.
export const handleWebhookEvent = internalMutation({
  args: {
    moolreReference: v.string(),
    status: v.optional(v.string()),
  },
  handler: async (ctx, { moolreReference, status }) => {
    const order = await ctx.db
      .query("orders")
      .withIndex("by_moolre_reference", (q) =>
        q.eq("moolreReference", moolreReference),
      )
      .first();

    if (!order) {
      console.error(`No order found for Moolre reference ${moolreReference}`);
      return;
    }

    // Idempotency guard: webhooks can and do fire more than once. If
    // we've already processed this order into "paid", do nothing further
    // rather than issuing duplicate tickets.
    if (order.status === "paid") {
      return;
    }

    const isSuccess = status === "success" || status === "completed";

    if (isSuccess) {
      await ctx.db.patch(order._id, {
        status: "paid",
        moolreStatus: status,
        paidAt: Date.now(),
      });

      await issueTickets(ctx, order._id);

      await ctx.scheduler.runAfter(0, internal.moolre.sendConfirmation, {
        orderId: order._id,
      });
    } else {
      await ctx.db.patch(order._id, {
        status: "failed",
        moolreStatus: status,
      });

      // Release the reservation immediately rather than waiting for the
      // timeout sweep, since we now know for certain payment failed.
      const ticketType = await ctx.db.get(order.ticketTypeId);
      if (ticketType) {
        await ctx.db.patch(order.ticketTypeId, {
          quantityReserved: Math.max(
            0,
            ticketType.quantityReserved - order.quantity,
          ),
        });
      }
    }
  },
});

// Sends an SMS (via Moolre's SMS API) confirming the purchase. Kept as
// a separate action (not inline in the mutation above) because mutations
// cannot make outbound fetch calls - only actions can.
export const sendConfirmation = internalAction({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    const order = await ctx.runQuery(internal.orders.getOrderInternal, {
      orderId,
    });
    if (!order) return;

    const message = `Nsaa Tickets: your order is confirmed. GHS ${order.totalGHS} paid. Your ticket(s) are ready in the app.`;

    // --- Moolre SMS ---
    // Confirm the real endpoint/payload shape against Moolre's SMS API
    // docs before going live.
    try {
      await fetch(`${process.env.MOOLRE_API_BASE}/v1/sms/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.MOOLRE_API_KEY}`,
        },
        body: JSON.stringify({
          to: order.buyerPhone,
          message,
        }),
      });
    } catch (err) {
      console.error("Moolre SMS failed", err);
    }

    // --- Brevo transactional email (only if buyer gave an email) ---
    if (order.buyerEmail) {
      try {
        await fetch("https://api.brevo.com/v3/smtp/email", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "api-key": process.env.BREVO_API_KEY ?? "",
          },
          body: JSON.stringify({
            sender: { name: "Nsaa Tickets", email: "tickets@nsaatickets.com" },
            to: [{ email: order.buyerEmail, name: order.buyerName }],
            subject: "Your Nsaa Tickets order is confirmed",
            htmlContent: `<p>Hi ${order.buyerName},</p><p>Your order is confirmed. GHS ${order.totalGHS} was charged. Open the app to view your ticket QR code.</p>`,
          }),
        });
      } catch (err) {
        console.error("Brevo email failed", err);
      }
    }
  },
});
