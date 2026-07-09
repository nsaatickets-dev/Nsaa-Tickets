import { mutation, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { escapeHtml, sendBrevoEmail, SENDERS, renderEmailLayout, paragraph } from "./email";

export const create = mutation({
  args: {
    organizerName: v.string(),
    contactName: v.string(),
    phone: v.string(),
    email: v.optional(v.string()),
    eventType: v.string(),
    eventCity: v.string(),
    expectedAttendance: v.optional(v.number()),
    message: v.string(),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("organizerInquiries", {
      ...args,
      status: "new",
      createdAt: Date.now(),
    });

    // Email is optional on this form (phone is the primary contact,
    // guest-first like checkout) - only send if they gave one.
    if (args.email) {
      await ctx.scheduler.runAfter(0, internal.organizerInquiries.sendAcknowledgement, {
        contactName: args.contactName,
        organizerName: args.organizerName,
        email: args.email,
      });
    }

    return id;
  },
});

export const sendAcknowledgement = internalAction({
  args: {
    contactName: v.string(),
    organizerName: v.string(),
    email: v.string(),
  },
  handler: async (ctx, { contactName, organizerName, email }) => {
    await sendBrevoEmail({
      sender: SENDERS.events,
      to: [{ email, name: contactName }],
      subject: "We've received your event inquiry",
      htmlContent: renderEmailLayout({
        heading: "We've received your event inquiry",
        bodyHtml:
          paragraph(`Hi ${escapeHtml(contactName)},`) +
          paragraph(
            `Thanks for telling us about ${escapeHtml(organizerName)}'s event. Our events team has received your inquiry and will follow up shortly to get you set up on Nsaa Tickets.`,
          ) +
          paragraph("&mdash; Nsaa Tickets Events"),
        footerNote: "You're receiving this because you submitted an event inquiry on Nsaa Tickets.",
      }),
    });
  },
});
