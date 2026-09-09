import { RateLimiter, MINUTE, HOUR } from "@convex-dev/rate-limiter";
import { components } from "./_generated/api";

// Convex mutations don't have access to the caller's IP (only httpActions
// do, and these forms are called directly via the Convex client, not
// through an HTTP route) - so limits are keyed on what the caller
// actually submits (phone/email/scanner key). That stops accidental
// double-submits and single-actor spam/abuse, which covers the realistic
// common case; it would not stop a determined attacker rotating a fresh
// email/phone per request. The global (unkeyed) limits below are a
// backstop against that - a site-wide ceiling regardless of who's asking.
export const rateLimiter = new RateLimiter(components.rateLimiter, {
  // Per phone number: stop one number from spamming reservation attempts
  // (each one holds real inventory for up to 10 minutes).
  reservationsByPhone: { kind: "fixed window", rate: 5, period: 10 * MINUTE },
  // Site-wide backstop regardless of phone number used.
  reservationsGlobal: { kind: "token bucket", rate: 60, period: MINUTE, capacity: 20 },

  // Public form spam protection.
  contactByEmail: { kind: "fixed window", rate: 3, period: HOUR },
  // Keyed on phone, not email - the organizer inquiry form makes phone
  // required and email optional (guest-first, same pattern as checkout).
  organizerInquiryByPhone: { kind: "fixed window", rate: 3, period: HOUR },
  newsletterByEmail: { kind: "fixed window", rate: 3, period: HOUR },

  // Scan attempts per scanner key - generous, since a busy door scans
  // fast, but still bounds a misbehaving/compromised device.
  scansByKey: { kind: "token bucket", rate: 120, period: MINUTE, capacity: 30 },

  // Inbound WhatsApp messages per phone number - generous enough for a
  // real back-and-forth conversation, bounds a single number hammering
  // the webhook (see convex/whatsapp.ts:recordInboundIfNew).
  whatsappInboundByPhone: { kind: "fixed window", rate: 30, period: MINUTE },

  // Payout phone name-lookup, keyed on the signed-in organizer's Clerk id.
  // This calls Moolre's Validate Name endpoint, which resolves a phone
  // number to the real person's registered name - a privacy-sensitive
  // lookup, not just an abuse-prevention one, so it's bounded even though
  // an authenticated organizer isn't otherwise a spam risk the way a
  // public form is.
  payoutPhoneValidationByOrganizer: { kind: "fixed window", rate: 10, period: MINUTE },
});
