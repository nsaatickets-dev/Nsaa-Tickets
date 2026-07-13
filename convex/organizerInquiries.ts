import { mutation, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { escapeHtml, sendBrevoEmail, SENDERS, renderEmailLayout, paragraph } from "./email";
import {
  optionalTrimmed,
  requireNonEmpty,
  requireValidEmail,
  requireValidGhanaPhone,
} from "./validation";
import { rateLimiter } from "./rateLimit";

export const create = mutation({
  args: {
    organizerName: v.string(),
    contactName: v.string(),
    phone: v.string(),
    email: v.optional(v.string()),
    supportNeeds: v.optional(v.array(v.string())),
    websiteUrl: v.optional(v.string()),
    payoutReadiness: v.optional(v.string()),
    message: v.string(),
  },
  handler: async (ctx, args) => {
    const organizerName = requireNonEmpty(args.organizerName, "Organizer name", 140);
    const contactName = requireNonEmpty(args.contactName, "Contact name", 120);
    const phone = requireValidGhanaPhone(args.phone);
    const email = args.email ? requireValidEmail(args.email) : undefined;
    const supportNeeds = args.supportNeeds
      ?.map((item) => optionalTrimmed(item, 80))
      .filter((item): item is string => Boolean(item))
      .slice(0, 8);
    const websiteUrl = optionalTrimmed(args.websiteUrl, 240);
    const payoutReadiness = optionalTrimmed(args.payoutReadiness, 80);
    const message = requireNonEmpty(args.message, "Message", 4000);

    // Keyed on phone, not email - phone is always required here, email
    // isn't (guest-first, same pattern as checkout).
    await rateLimiter.limit(ctx, "organizerInquiryByPhone", { key: phone, throws: true });

    const id = await ctx.db.insert("organizerInquiries", {
      organizerName,
      contactName,
      phone,
      email,
      supportNeeds,
      websiteUrl,
      payoutReadiness,
      message,
      status: "new",
      createdAt: Date.now(),
    });

    // Email is optional on this form (phone is the primary contact,
    // guest-first like checkout) - only send if they gave one.
    if (email) {
      await ctx.scheduler.runAfter(0, internal.organizerInquiries.sendAcknowledgement, {
        contactName,
        organizerName,
        email,
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
      subject: "We've received your organizer request",
      htmlContent: renderEmailLayout({
        heading: "We've received your organizer request",
        bodyHtml:
          paragraph(`Hi ${escapeHtml(contactName)},`) +
          paragraph(
            `Thanks for telling us about ${escapeHtml(organizerName)}. Our events team has received your request and will follow up shortly to get you set up on Nsaa Tickets.`,
          ) +
          paragraph("&mdash; Nsaa Tickets Events"),
        footerNote: "You're receiving this because you submitted an organizer setup request on Nsaa Tickets.",
      }),
    });
  },
});
