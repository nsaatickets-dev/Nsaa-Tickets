import { internalAction, internalMutation, ActionCtx } from "./_generated/server";
import { internal, api } from "./_generated/api";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { WHATSAPP_GRAPH_API_BASE, requireWhatsAppEnv } from "./whatsappConfig";
import { rateLimiter } from "./rateLimit";

const SITE_ORIGIN = "https://nsaatickets.com";

// How long before an event starts to send the WhatsApp reminder. Sent via
// an approved message template (see sendEventReminder below) since this
// fires well outside Meta's 24h customer-service session window.
export const REMINDER_LEAD_MS = 24 * 60 * 60 * 1000;

// Meta's error code for "you tried to free-form message a user outside
// the 24h window and they have no active session" - the one case where a
// buyer's own confirmation has to fall back to an approved template.
const OUTSIDE_SESSION_WINDOW_ERROR_CODE = 131047;

const FAQ_ANSWERS: Record<string, string> = {
  refunds:
    "All ticket sales are final except when an event is fully cancelled by the organizer, in which case a refund is processed automatically. Service fees are never refunded.",
  qr: "After you pay, we'll send your ticket right here as a QR code image. Show it at the door - your ticket is checked at each entry, so keep it safe and don't forward it to anyone else.",
  human: "You can reach our support team any time at support@nsaatickets.com and we'll get back to you as soon as we can.",
};

function matchFaqKeyword(text: string): string | undefined {
  const lower = text.toLowerCase();
  if (lower.includes("refund")) return "refunds";
  if (lower.includes("qr") || (lower.includes("ticket") && lower.includes("code"))) return "qr";
  if (lower.includes("human") || lower.includes("agent") || lower.includes("support")) return "human";
  return undefined;
}

// --- Meta webhook signature verification ---
// Meta's WhatsApp webhook (unlike Moolre's, which has no documented
// signature scheme - see moolre.ts) signs every POST body with
// X-Hub-Signature-256, an HMAC-SHA256 over the raw request body using the
// app secret. Same sign/compare shape as tickets.ts's QR-token HMAC, kept
// local to this file rather than shared - each provider file owns its own
// crypto helpers in this codebase (see moolreConfig.ts vs tickets.ts).
function timingSafeEqualLocal(a: string, b: string): boolean {
  const maxLength = Math.max(a.length, b.length);
  let mismatch = a.length === b.length ? 0 : 1;
  for (let i = 0; i < maxLength; i++) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}

export async function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | null,
): Promise<boolean> {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret || !signatureHeader || !signatureHeader.startsWith("sha256=")) return false;

  const expectedHex = signatureHeader.slice("sha256=".length);
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const actualHex = Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return timingSafeEqualLocal(actualHex, expectedHex);
}

// --- Low-level Graph API sender ---
// Returns the parsed response body (even on failure) so callers can
// inspect `.error.code` - specifically to detect the outside-session-
// window error and fall back to a template message.
async function sendRaw(to: string, payload: Record<string, unknown>): Promise<any> {
  try {
    const config = requireWhatsAppEnv(["WHATSAPP_API_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"]);
    const response = await fetch(
      `${WHATSAPP_GRAPH_API_BASE}/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.WHATSAPP_API_TOKEN}`,
        },
        body: JSON.stringify({ messaging_product: "whatsapp", to, ...payload }),
      },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("WhatsApp send failed", JSON.stringify(data));
    }
    return data;
  } catch (err) {
    console.error("WhatsApp send error", err);
    return { error: { code: 0, message: String(err) } };
  }
}

async function sendTemplateMessage(to: string, templateName: string, bodyParams: string[]) {
  await sendRaw(to, {
    type: "template",
    template: {
      name: templateName,
      language: { code: "en" },
      components: [
        { type: "body", parameters: bodyParams.map((text) => ({ type: "text", text })) },
      ],
    },
  });
}

function isOutsideSessionWindowError(result: any): boolean {
  return result?.error?.code === OUTSIDE_SESSION_WINDOW_ERROR_CODE;
}

// --- Message builders (plain functions, not Convex functions - same
// pattern as tickets.ts's issueTickets helper) ---

function textPayload(body: string) {
  return { type: "text", text: { body } };
}

function listPayload(
  bodyText: string,
  buttonLabel: string,
  rows: { id: string; title: string; description?: string }[],
) {
  return {
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: bodyText },
      action: {
        button: buttonLabel.slice(0, 20),
        sections: [{ title: "Options", rows }],
      },
    },
  };
}

function mainMenuPayload() {
  return listPayload("Hi! Welcome to Nsaa Tickets. What would you like to do?", "Menu", [
    { id: "menu:browse", title: "Browse events", description: "See what's on sale" },
    { id: "menu:faq", title: "FAQ / Support", description: "Refunds, QR codes, help" },
  ]);
}

// --- Reply senders (plain async functions - only handleInboundMessage,
// sendTicketConfirmation and sendEventReminder below are exposed as
// Convex functions, since nothing outside this file calls the others) ---

async function sendMainMenu(waPhone: string) {
  await sendRaw(waPhone, mainMenuPayload());
}

async function sendEventList(ctx: ActionCtx, waPhone: string) {
  const events = await ctx.runQuery(api.events.listPublished, {});
  const upcoming = events
    .filter((event) => event.startsAt > Date.now())
    .sort((a, b) => a.startsAt - b.startsAt)
    .slice(0, 10);

  if (upcoming.length === 0) {
    await sendRaw(waPhone, textPayload("No upcoming events right now - check back soon!"));
    return;
  }

  const rows = upcoming.map((event) => ({
    id: `evt:${event._id}`,
    title: event.title.slice(0, 24),
    description: `${event.venue}, ${event.city}`.slice(0, 72),
  }));

  await sendRaw(waPhone, listPayload("Upcoming events - tap one to see ticket options", "Events", rows));
}

async function sendTicketTypeList(ctx: ActionCtx, waPhone: string, eventId: Id<"events">) {
  const ticketTypes = await ctx.runQuery(api.events.ticketTypesForEvent, { eventId });
  const available = ticketTypes.filter((t) => t.quantityAvailable > 0);

  if (available.length === 0) {
    await sendRaw(waPhone, textPayload("Sorry, this event is sold out."));
    return;
  }

  const rows = available.slice(0, 10).map((t) => ({
    id: `tix:${eventId}:${t._id}`,
    title: t.name.slice(0, 24),
    description: `GHS ${t.priceGHS} - ${t.quantityAvailable} left`,
  }));

  await sendRaw(waPhone, listPayload("Choose a ticket type", "Ticket types", rows));
}

async function sendCheckoutLinkForReply(
  waPhone: string,
  eventId: Id<"events">,
  ticketTypeId: Id<"ticketTypes">,
) {
  const link = `${SITE_ORIGIN}/checkout.html?eventId=${eventId}&ticketTypeId=${ticketTypeId}&ref=whatsapp&waPhone=${encodeURIComponent(waPhone)}`;
  await sendRaw(
    waPhone,
    textPayload(
      `Tap to complete your purchase:\n${link}\n\nOnce you pay, your ticket(s) will be sent right back here.`,
    ),
  );
}

async function sendFaqMenu(waPhone: string) {
  await sendRaw(
    waPhone,
    listPayload("What do you need help with?", "FAQ", [
      { id: "faq:refunds", title: "Refund policy" },
      { id: "faq:qr", title: "How QR codes work" },
      { id: "faq:human", title: "Talk to a human" },
    ]),
  );
}

async function sendFaqAnswer(waPhone: string, key: string) {
  const answer = FAQ_ANSWERS[key];
  await sendRaw(
    waPhone,
    textPayload(answer ?? "Sorry, I didn't understand that. Reach us at support@nsaatickets.com."),
  );
}

async function routeReplyId(ctx: ActionCtx, waPhone: string, replyId: string) {
  const [prefix, a, b] = replyId.split(":");

  if (prefix === "menu" && a === "browse") return sendEventList(ctx, waPhone);
  if (prefix === "menu" && a === "faq") return sendFaqMenu(waPhone);
  if (prefix === "evt" && a) return sendTicketTypeList(ctx, waPhone, a as Id<"events">);
  if (prefix === "tix" && a && b) {
    return sendCheckoutLinkForReply(waPhone, a as Id<"events">, b as Id<"ticketTypes">);
  }
  if (prefix === "faq" && a) return sendFaqAnswer(waPhone, a);

  return sendMainMenu(waPhone);
}

// Dedupes Meta's webhook (which can and does redeliver the same message)
// and rate-limits by phone, in one round trip since both need the same
// mutation context. Mirrors applyVerifiedStatus's idempotency guard in
// moolre.ts. Always records the message as seen, even when rate-limited,
// so a spammy retry loop can't get free re-attempts.
export const recordInboundIfNew = internalMutation({
  args: { messageId: v.string(), waPhone: v.string() },
  handler: async (ctx, { messageId, waPhone }) => {
    const existing = await ctx.db
      .query("whatsappInboundLog")
      .withIndex("by_message_id", (q) => q.eq("messageId", messageId))
      .unique();
    if (existing) return { proceed: false };

    const limit = await rateLimiter.limit(ctx, "whatsappInboundByPhone", { key: waPhone });
    await ctx.db.insert("whatsappInboundLog", { messageId, waPhone, createdAt: Date.now() });

    return { proceed: limit.ok };
  },
});

// Entry point called from the /whatsapp/webhook POST route (convex/http.ts)
// for each inbound message. Deliberately button/list-driven, not free-text
// NLP - the only free-text handling is a keyword match for FAQ, falling
// back to the main menu.
export const handleInboundMessage = internalAction({
  args: { message: v.any() },
  handler: async (ctx, { message }) => {
    const waPhone: string | undefined = message?.from;
    const messageId: string | undefined = message?.id;
    if (!waPhone || !messageId) return;

    const { proceed } = await ctx.runMutation(internal.whatsapp.recordInboundIfNew, {
      messageId,
      waPhone,
    });
    if (!proceed) return;

    if (message.type === "interactive") {
      const replyId: string | undefined =
        message.interactive?.list_reply?.id ?? message.interactive?.button_reply?.id;
      if (replyId) {
        await routeReplyId(ctx, waPhone, replyId);
        return;
      }
    }

    if (message.type === "text") {
      const body: string = message.text?.body ?? "";
      const faqKey = matchFaqKeyword(body);
      if (faqKey) {
        await sendFaqAnswer(waPhone, faqKey);
        return;
      }
    }

    await sendMainMenu(waPhone);
  },
});

// Called from moolre.ts's applyVerifiedStatus when a WhatsApp-originated
// order is confirmed paid. Sends a summary text plus one image message
// per ticket, pointing at the same hosted QR endpoint the confirmation
// email already uses (convex/http.ts's /tickets/qr route). Falls back to
// an approved template if the buyer paid long enough after messaging that
// they've fallen outside Meta's 24h session window - the free-form send
// is always tried first since most confirmations land well inside it.
export const sendTicketConfirmation = internalAction({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    const order = await ctx.runQuery(internal.orders.getOrderInternal, { orderId });
    if (!order?.whatsappPhone) return;

    const detailed = await ctx.runQuery(api.tickets.ticketsForOrderDetailed, { orderId });
    if (!detailed || detailed.tickets.length === 0) return;
    const { event, ticketType, tickets } = detailed;
    const to = order.whatsappPhone;

    const summary = `Your Nsaa Tickets order is confirmed! GHS ${order.totalGHS} paid for ${tickets.length}x ${ticketType?.name ?? "Ticket"} - ${event?.title ?? ""}. Your ticket${tickets.length > 1 ? "s are" : " is"} below.`;

    const result = await sendRaw(to, textPayload(summary));

    if (isOutsideSessionWindowError(result)) {
      await sendTemplateMessage(to, "ticket_confirmed", [
        event?.title ?? "your event",
        String(tickets.length),
      ]);
      return; // approved template has no room for per-ticket QR images
    }

    for (let i = 0; i < tickets.length; i++) {
      const ticket = tickets[i];
      await sendRaw(to, {
        type: "image",
        image: {
          link: `${SITE_ORIGIN}/tickets/qr?ticketId=${ticket._id}`,
          caption: `${ticketType?.name ?? "Ticket"} ${i + 1}/${tickets.length} - ${event?.title ?? ""}`,
        },
      });
    }
  },
});

// Scheduled at event.startsAt - REMINDER_LEAD_MS by moolre.ts when a
// WhatsApp-sourced order is confirmed paid, with a periodic cron
// safety-net (see crons.ts) in case that scheduled call is missed. This
// is an unsolicited send well outside any 24h session window by design,
// so it always uses the approved template rather than trying free-form
// first.
export const sendEventReminder = internalAction({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    const detailed = await ctx.runQuery(api.tickets.ticketsForOrderDetailed, { orderId });
    if (!detailed?.order || !detailed.event) return;
    const { order, event } = detailed;

    if (order.status !== "paid" || !order.whatsappPhone) return;
    if (order.reminderSentAt) return; // already sent - scheduled call and cron sweep can race
    if (event.status === "cancelled") return;
    if (event.startsAt <= Date.now()) return; // event already started/passed

    const when = new Date(event.startsAt).toLocaleString("en-GB", {
      timeZone: "Africa/Accra",
      dateStyle: "medium",
      timeStyle: "short",
    });

    await sendTemplateMessage(order.whatsappPhone, "event_reminder", [
      event.title,
      when,
      event.venue,
    ]);

    await ctx.runMutation(internal.orders.markReminderSent, { orderId });
  },
});

// Periodic safety-net sweep (wired up in crons.ts) in case a scheduled
// reminder was missed - e.g. a deploy happened at the wrong moment, same
// justification as orders.ts's sweepExpiredReservations.
export const sweepMissedEventReminders = internalAction({
  args: {},
  handler: async (ctx) => {
    const horizon = Date.now() + REMINDER_LEAD_MS + 10 * 60 * 1000; // small buffer past the lead time
    const upcomingEvents = await ctx.runQuery(internal.events.listPublishedStartingBefore, {
      before: horizon,
    });

    for (const event of upcomingEvents) {
      const orders = await ctx.runQuery(internal.orders.whatsappOrdersNeedingReminder, {
        eventId: event._id,
      });
      for (const order of orders) {
        await ctx.runAction(internal.whatsapp.sendEventReminder, { orderId: order._id });
      }
    }
  },
});
