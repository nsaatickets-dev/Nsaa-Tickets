import { mutation, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { escapeHtml, sendBrevoEmail, SENDERS, renderEmailLayout, paragraph } from "./email";
import {
  optionalTrimmed,
  requireNonEmpty,
  requireValidEmail,
  requireValidGhanaPhone,
  requirePositiveInteger,
} from "./validation";
import { rateLimiter } from "./rateLimit";

export const create = mutation({
  args: {
    organizerName: v.string(),
    contactName: v.string(),
    phone: v.string(),
    email: v.optional(v.string()),
    eventType: v.optional(v.string()),
    eventCity: v.optional(v.string()),
    eventDate: v.optional(v.string()),
    ticketingModel: v.optional(v.string()),
    launchWindow: v.optional(v.string()),
    expectedAttendance: v.optional(v.number()),
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
    const eventType = optionalTrimmed(args.eventType, 60);
    const eventCity = optionalTrimmed(args.eventCity, 80);
    const eventDate = optionalTrimmed(args.eventDate, 40);
    const ticketingModel = optionalTrimmed(args.ticketingModel, 60);
    const launchWindow = optionalTrimmed(args.launchWindow, 60);
    const supportNeeds = args.supportNeeds
      ?.map((item) => optionalTrimmed(item, 80))
      .filter((item): item is string => Boolean(item))
      .slice(0, 8);
    const websiteUrl = optionalTrimmed(args.websiteUrl, 240);
    const payoutReadiness = optionalTrimmed(args.payoutReadiness, 80);
    const message = requireNonEmpty(args.message, "Message", 4000);
    const expectedAttendance =
      args.expectedAttendance !== undefined
        ? requirePositiveInteger(args.expectedAttendance, "Expected attendance", 1_000_000)
        : undefined;

    // Keyed on phone, not email - phone is always required here, email
    // isn't (guest-first, same pattern as checkout).
    await rateLimiter.limit(ctx, "organizerInquiryByPhone", { key: phone, throws: true });

    const id = await ctx.db.insert("organizerInquiries", {
      organizerName,
      contactName,
      phone,
      email,
      eventType,
      eventCity,
      eventDate,
      ticketingModel,
      launchWindow,
      expectedAttendance,
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
      subject: "We've received your organizer signup",
      htmlContent: renderEmailLayout({
        heading: "We've received your organizer signup",
        bodyHtml:
          paragraph(`Hi ${escapeHtml(contactName)},`) +
          paragraph(
            `Thanks for telling us about ${escapeHtml(organizerName)}. Our events team has received your signup and will follow up shortly to get you set up on Nsaa Tickets.`,
          ) +
          paragraph("&mdash; Nsaa Tickets Events"),
        footerNote: "You're receiving this because you submitted an organizer signup on Nsaa Tickets.",
      }),
    });
  },
});
