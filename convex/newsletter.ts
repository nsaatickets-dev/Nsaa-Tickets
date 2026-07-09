import { mutation, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { sendBrevoEmail, SENDERS, renderEmailLayout, paragraph } from "./email";

export const subscribe = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const normalized = email.trim().toLowerCase();

    const existing = await ctx.db
      .query("newsletterSubscribers")
      .withIndex("by_email", (q) => q.eq("email", normalized))
      .unique();
    if (existing) return existing._id;

    const id = await ctx.db.insert("newsletterSubscribers", {
      email: normalized,
      createdAt: Date.now(),
    });

    await ctx.scheduler.runAfter(0, internal.newsletter.sendWelcome, {
      email: normalized,
    });

    return id;
  },
});

export const sendWelcome = internalAction({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    await sendBrevoEmail({
      sender: SENDERS.hello,
      to: [{ email }],
      subject: "Welcome to Nsaa Tickets",
      htmlContent: renderEmailLayout({
        heading: "Welcome to Nsaa Tickets",
        bodyHtml:
          paragraph("Hi there,") +
          paragraph(
            "You're on the list. We'll let you know when new events go live in Ghana &mdash; concerts, nightlife, conferences, sports, and more.",
          ) +
          paragraph("&mdash; Nsaa Tickets"),
        footerNote: "You're receiving this because you subscribed on nsaatickets.com.",
      }),
    });
  },
});
