import { internalMutation, internalAction } from "../_generated/server";
import { internal, api } from "../_generated/api";
import { v } from "convex/values";
import { issueTickets } from "../tickets";
import { escapeHtml, sendBrevoEmail, SENDERS, renderEmailLayout, paragraph, ticketBlock } from "../email";
import { alertCritical } from "../alerts";
import { requireMoolreEnv } from "../moolreConfig";
import { REMINDER_LEAD_MS } from "../whatsapp";
import { isMoolreAccepted, checkStatus, sendSms } from "./client";

// Called from convex/http.ts when Moolre POSTs to our webhook, after it
// has already parsed the `order:<id>` prefix off data.externalref.
//
// Moolre's docs (docs.moolre.com/ai/payment-webhook) don't specify any
// signature header or HMAC scheme for verifying a webhook actually came
// from Moolre, so we don't trust the POSTed body's status at all. Instead
// the webhook is treated purely as a "check now" nudge: re-fetch the
// authoritative status straight from Moolre's own status endpoint using
// the exact externalref we originally sent, and only ever act on that
// response.
export const verifyAndProcessPayment = internalAction({
  args: { externalref: v.string(), orderId: v.id("orders") },
  handler: async (ctx, { externalref, orderId }) => {
    let txstatus: number | undefined;
    let transactionId: string | undefined;

    try {
      const config = requireMoolreEnv([
        "MOOLRE_API_BASE",
        "MOOLRE_API_USER",
        "MOOLRE_API_PUBKEY",
        "MOOLRE_ACCOUNT_NUMBER",
      ]);
      const result = await checkStatus(config, { idtype: "1", id: externalref });
      txstatus = result.txstatus;
      transactionId = result.transactionId;
    } catch (err) {
      // We've lost visibility into whether this order was actually paid -
      // not a routine decline, a real infrastructure failure worth a
      // human looking at.
      await alertCritical(
        "Moolre status check failed",
        `Could not verify payment status for order ${orderId} (externalref ${externalref}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    await ctx.runMutation(internal.moolre.webhook.applyVerifiedStatus, {
      orderId,
      isSuccess: isMoolreAccepted(txstatus),
      transactionId,
    });
  },
});

// This is the single place that flips an order from "reserved" to
// "paid" - only ever called with a status we fetched ourselves above,
// never with client- or webhook-supplied data directly.
export const applyVerifiedStatus = internalMutation({
  args: {
    orderId: v.id("orders"),
    isSuccess: v.boolean(),
    transactionId: v.optional(v.string()),
  },
  handler: async (ctx, { orderId, isSuccess, transactionId }) => {
    // Not a confirmed success - Moolre's docs don't document failure-state
    // txstatus values, so rather than guess and prematurely kill a
    // reservation that might still be mid-approval, we do nothing and let
    // the existing 10-minute reservation timeout / cron sweep be the
    // backstop for a real failure or no-show.
    if (!isSuccess) return;

    const order = await ctx.db.get(orderId);
    if (!order) {
      console.error(`No order found for id ${orderId}`);
      return;
    }

    // Idempotency guard: the webhook can and does fire more than once,
    // and this action can be re-triggered - don't issue duplicate tickets.
    if (order.status === "paid") return;
    // Already expired/failed - don't resurrect a dead reservation.
    if (order.status !== "reserved") return;

    await ctx.db.patch(order._id, {
      status: "paid",
      moolreStatus: "success",
      moolreReference: transactionId ?? order.moolreReference,
      paidAt: Date.now(),
    });

    await issueTickets(ctx, order._id);

    // A paid order landing after the event was marked settled (see
    // payouts.ts's markPayoutSettledIfUnset) means there's new revenue to
    // pay out after all - un-settle it so the payout sweep picks it back up.
    const event = await ctx.db.get(order.eventId);
    if (event?.payoutSettledAt !== undefined) {
      await ctx.db.patch(event._id, { payoutSettledAt: undefined });
    }

    await ctx.scheduler.runAfter(0, internal.moolre.webhook.sendConfirmation, {
      orderId: order._id,
    });
    // Independent of the buyer confirmation above - a failure here (or a
    // missing organizer contact email) must never block ticket delivery.
    await ctx.scheduler.runAfter(0, internal.moolre.webhook.sendOrganizerNotification, {
      orderId: order._id,
    });
    await ctx.scheduler.runAfter(0, internal.serviceFees.sweepServiceFeeForOrder, {
      orderId: order._id,
    });

    // WhatsApp-originated order (see orders.ts:createReservation's waPhone
    // arg) - additive on top of the SMS/email confirmation above, never a
    // replacement for it.
    if (order.source === "whatsapp" && order.whatsappPhone) {
      await ctx.scheduler.runAfter(0, internal.whatsapp.sendTicketConfirmation, {
        orderId: order._id,
      });

      if (event && event.startsAt > Date.now()) {
        const fireAt = Math.max(Date.now(), event.startsAt - REMINDER_LEAD_MS);
        await ctx.scheduler.runAt(fireAt, internal.whatsapp.sendEventReminder, {
          orderId: order._id,
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

    try {
      const config = requireMoolreEnv(["MOOLRE_API_BASE", "MOOLRE_VASKEY"]);
      await sendSms(config, {
        senderid: process.env.MOOLRE_SMS_SENDER_ID ?? "",
        recipient: order.buyerPhone,
        message,
      });
    } catch (err) {
      console.error("Moolre SMS failed", err);
    }

    // --- Brevo transactional email: the receipt IS the ticket ---
    // The buyer's email is required at checkout specifically so this can
    // carry the actual scannable QR code(s), not just point back at the
    // app - someone should be able to walk in on a forwarded/printed copy
    // of this email alone.
    const detailed = await ctx.runQuery(api.tickets.ticketsForOrderDetailed, { orderId });
    if (detailed && detailed.tickets.length > 0) {
      const siteUrl = process.env.CONVEX_SITE_URL ?? "";
      const ticketTypeName = detailed.ticketType?.name ?? "Ticket";
      const daysTotal = detailed.tickets[0]?.validDayTimestamps?.length;
      const scanNote =
        daysTotal && daysTotal > 1
          ? `each is valid for ${daysTotal} days - one scan admits per day`
          : "each code can only be scanned once";
      const ticketsHtml = detailed.tickets
        .map((ticket, index) =>
          ticketBlock({
            qrImageUrl: `${siteUrl}/tickets/qr?ticketId=${ticket._id}`,
            ticketTypeName,
            ownerName: ticket.ownerName,
            index,
            total: detailed.tickets.length,
          }),
        )
        .join("");
      const attachment: { name: string; content: string }[] = [];

      try {
        const ticketPdfBase64: string = await ctx.runAction(internal.qrImage.ticketsToPdfBase64, {
          eventTitle: detailed.event?.title ?? "Nsaa Tickets event",
          venue: detailed.event?.venue ?? "Venue TBA",
          startsAt: detailed.event?.startsAt,
          ticketTypeName,
          daysTotal,
          tickets: detailed.tickets.map((ticket, index) => ({
            qrToken: ticket.qrToken,
            ownerName: ticket.ownerName,
            ticketId: ticket._id,
            index,
          })),
        });
        attachment.push({
          name: `nsaa-tickets-${order._id}.pdf`,
          content: ticketPdfBase64,
        });
      } catch (err) {
        console.error("Ticket PDF generation failed", err);
      }

      await sendBrevoEmail({
        sender: SENDERS.tickets,
        to: [{ email: order.buyerEmail, name: order.buyerName }],
        subject: "Your Nsaa Tickets order is confirmed",
        htmlContent: renderEmailLayout({
          heading: "Your order is confirmed",
          bodyHtml:
            paragraph(`Hi ${escapeHtml(order.buyerName)},`) +
            paragraph(
              `Your order is confirmed. <strong>GHS ${order.totalGHS}</strong> was charged. A printable PDF ticket file is attached, and your ticket${detailed.tickets.length > 1 ? "s are" : " is"} also below - ${scanNote}, so keep this email or a screenshot handy at the door.`,
            ) +
            ticketsHtml,
          footerNote: "This email confirms a ticket purchase on Nsaa Tickets.",
        }),
        attachment: attachment.length > 0 ? attachment : undefined,
      });
    }
  },
});

// Lets an organizer find out about a sale without having to keep the
// dashboard open. Separate action from sendConfirmation (not just an extra
// step inside it) so a Brevo failure or a missing organizer contact email
// can never delay or block the buyer's own ticket email above.
export const sendOrganizerNotification = internalAction({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    const detailed = await ctx.runQuery(api.tickets.ticketsForOrderDetailed, { orderId });
    if (!detailed?.order || !detailed.event) return;
    const { order, event, ticketType } = detailed;

    const contact = await ctx.runQuery(internal.events.getOrganizerContactForEvent, {
      eventId: event._id,
    });
    if (!contact) return;

    await sendBrevoEmail({
      sender: SENDERS.events,
      to: [{ email: contact.contactEmail, name: contact.organizerName }],
      subject: `New ticket sale: ${event.title}`,
      htmlContent: renderEmailLayout({
        heading: "You have a new ticket sale",
        bodyHtml:
          paragraph(`Hi ${escapeHtml(contact.organizerName)},`) +
          paragraph(
            `<strong>${order.quantity}&times; ${escapeHtml(ticketType?.name ?? "Ticket")}</strong> just sold for <strong>${escapeHtml(event.title)}</strong>.`,
          ) +
          paragraph(
            `Buyer: ${escapeHtml(order.buyerName)} (${escapeHtml(order.buyerPhone)})<br/>Your payout for this order: GHS ${order.ticketSubtotalGHS}`,
          ),
        footerNote: "This email confirms a ticket sale on Nsaa Tickets.",
      }),
    });
  },
});
