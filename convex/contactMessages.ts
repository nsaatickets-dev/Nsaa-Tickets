import { mutation, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { escapeHtml, sendBrevoEmail, SENDERS, renderEmailLayout, paragraph } from "./email";
import { requireNonEmpty, requireValidEmail } from "./validation";
import { rateLimiter } from "./rateLimit";

const TOPIC_LABEL: Record<string, string> = {
  support: "support",
  payments: "a payment",
  press: "press",
  partnerships: "a partnership",
  other: "your message",
};

export const create = mutation({
  args: {
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
  },
  handler: async (ctx, args) => {
    const name = requireNonEmpty(args.name, "Name", 120);
    const email = requireValidEmail(args.email);
    const message = requireNonEmpty(args.message, "Message", 4000);

    await rateLimiter.limit(ctx, "contactByEmail", { key: email, throws: true });

    const id = await ctx.db.insert("contactMessages", {
      name,
      email,
      topic: args.topic,
      message,
      status: "new",
      createdAt: Date.now(),
    });

    await ctx.scheduler.runAfter(0, internal.contactMessages.sendAcknowledgement, {
      name,
      email,
      topic: args.topic,
    });

    return id;
  },
});

export const sendAcknowledgement = internalAction({
  args: {
    name: v.string(),
    email: v.string(),
    topic: v.string(),
  },
  handler: async (ctx, { name, email, topic }) => {
    const topicLabel = TOPIC_LABEL[topic] ?? "your message";
    await sendBrevoEmail({
      sender: SENDERS.support,
      to: [{ email, name }],
      subject: "We've received your message",
      htmlContent: renderEmailLayout({
        heading: "We've received your message",
        bodyHtml:
          paragraph(`Hi ${escapeHtml(name)},`) +
          paragraph(
            `Thanks for reaching out to Nsaa Tickets about ${escapeHtml(topicLabel)}. Our support team has received your message and will get back to you shortly.`,
          ) +
          paragraph("&mdash; Nsaa Tickets Support"),
        footerNote: "You're receiving this because you contacted Nsaa Tickets support.",
      }),
    });
  },
});
