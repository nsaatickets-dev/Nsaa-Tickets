import { action, mutation, internalAction, internalMutation, internalQuery, query } from "./_generated/server";
import { internal, api } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { v } from "convex/values";
import { requireAdmin, logAdminAction, type AdminIdentity } from "./admin";
import { requireOwnedEvent } from "./events";
import { alertCritical } from "./alerts";
import { requireMoolreEnv } from "./moolreConfig";
import { sendBrevoEmail, SENDERS, renderEmailLayout, paragraph, escapeHtml } from "./email";
import { requireValidGhanaPhone } from "./validation";
import { rateLimiter } from "./rateLimit";
import {
  isMoolreAccepted,
  checkStatus,
  requestTransfer,
  validateName,
  transferChannelsToTry,
  ALL_MOOLRE_TRANSFER_CHANNELS,
} from "./moolre/client";

// Attributes automatic (cron-triggered) payouts in the same audit trail
// as admin-triggered ones, so the Audit Log tab shows a single timeline
// of every payout regardless of who/what started it.
const SYSTEM_IDENTITY: AdminIdentity = { subject: "system", label: "Automatic payout" };
const AUTO_PAYOUT_FAILED_RETRY_DELAY_MS = 30 * 60 * 1000;
// Caps how many times the automatic sweep will retry one event's payout
// before giving up and waiting for a human. Without this, a permanently
// bad payout phone/account (the failure Moolre reports isn't something a
// retry ever fixes) retries forever - one event hit ~500 failed attempts
// over 12 days before this cap existed. Admin-triggered retries (strict
// mode) bypass this, same as they already bypass the recent-failure
// backoff below.
const MAX_AUTO_PAYOUT_ATTEMPTS = 5;

// Organizer-facing: Moolre's own Validate Name docs recommend showing the
// initiator the resolved account name before a transfer, so an organizer
// can catch a mistyped payout number before it costs them a failed/
// misdirected payout later. Tries every channel (not just the
// prefix-guessed one) before giving up - a ported number would otherwise
// come back as a false "not found" - and only reports "not_found" once
// every channel gives Moolre's own documented AVD02 response; anything
// else (including the undocumented, currently-ongoing MTN/AT/bank
// failures - see payoutEventIfDue's channel fallback) is surfaced as
// "unavailable" rather than a false claim that the number is invalid.
export const validateOrganizerPayoutPhone = action({
  args: { phone: v.string() },
  handler: async (
    ctx,
    { phone },
  ): Promise<{ status: "confirmed" | "not_found" | "unavailable"; name?: string }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Sign in required.");
    await rateLimiter.limit(ctx, "payoutPhoneValidationByOrganizer", {
      key: identity.subject,
      throws: true,
    });

    let normalizedPhone: string;
    try {
      normalizedPhone = requireValidGhanaPhone(phone);
    } catch {
      return { status: "unavailable" };
    }

    const config = requireMoolreEnv([
      "MOOLRE_API_BASE",
      "MOOLRE_API_USER",
      "MOOLRE_API_KEY",
      "MOOLRE_ACCOUNT_NUMBER",
    ]);

    let sawDefiniteNotFound = false;
    for (const channel of transferChannelsToTry(normalizedPhone)) {
      const result = await validateName(config, { channel, receiver: normalizedPhone });
      if (isMoolreAccepted(result.status) && typeof result.name === "string") {
        return { status: "confirmed", name: result.name };
      }
      if (result.code === "AVD02") {
        sawDefiniteNotFound = true;
      }
    }

    return { status: sawDefiniteNotFound ? "not_found" : "unavailable" };
  },
});

// How much of an event's ticket revenue is eligible for payout right now:
// paid orders' ticket subtotal only (the organizer's cut - the service
// fee is always retained by the platform and never appears here), minus
// anything already paid out or currently mid-transfer for this event.
export const eligiblePayoutAmount = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const paidOrders = await ctx.db
      .query("orders")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .filter((q) => q.eq(q.field("status"), "paid"))
      .collect();

    const grossGHS = paidOrders.reduce((sum, o) => sum + o.ticketSubtotalGHS, 0);

    // "Not failed" (paid or pending) as two indexed lookups rather than
    // by_event's full history filtered in memory - a repeatedly-failing
    // payout can pile up hundreds of "failed" rows for one event, and
    // this query runs on every automatic retry, so scanning past them
    // every time would make each retry more expensive than the last.
    const [paidPayouts, pendingPayouts] = await Promise.all([
      ctx.db
        .query("payouts")
        .withIndex("by_event_status_created", (q) => q.eq("eventId", eventId).eq("status", "paid"))
        .collect(),
      ctx.db
        .query("payouts")
        .withIndex("by_event_status_created", (q) => q.eq("eventId", eventId).eq("status", "pending"))
        .collect(),
    ]);

    const alreadyAccountedGHS = [...paidPayouts, ...pendingPayouts].reduce(
      (sum, p) => sum + p.amountGHS,
      0,
    );

    return Math.max(0, Math.round((grossGHS - alreadyAccountedGHS) * 100) / 100);
  },
});

export const payoutsForEvent = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    return await ctx.db
      .query("payouts")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect();
  },
});

// Organizer-facing: their own interim-payout request history for one of
// their events (pending/approved/rejected) - read-only, so this repeats
// requireOwnedEvent's identity/ownership check inline rather than
// importing it (that helper is typed for MutationCtx, not QueryCtx).
export const payoutRequestsForEvent = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Sign in required.");
    const event = await ctx.db.get(eventId);
    if (!event) throw new Error("Event not found.");
    if (event.organizerClerkUserId !== identity.subject) {
      throw new Error("You do not have access to this event.");
    }
    return await ctx.db
      .query("payoutRequests")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect();
  },
});

// Organizer-facing: Pro/Custom tier perk - request an interim payout of
// accrued ticket revenue while sales are still running, instead of
// waiting for the event to end. Never moves money itself - it only
// creates a request row for an admin to approve/reject (see
// approvePayoutRequest/rejectPayoutRequest below), matching this app's
// existing all-admin-gated design for anything that actually transfers
// money out.
export const requestInterimPayout = mutation({
  args: { eventId: v.id("events"), amountGHS: v.number() },
  handler: async (ctx, { eventId, amountGHS }) => {
    const { identity, event } = await requireOwnedEvent(ctx, eventId);

    const profile = await ctx.db
      .query("organizerProfiles")
      .withIndex("by_organizer", (q) => q.eq("organizerClerkUserId", identity.subject))
      .unique();
    if (!profile || (profile.tier !== "pro" && profile.tier !== "custom")) {
      throw new Error("Interim payouts are a Pro/Custom plan perk. Upgrade your plan to request one.");
    }
    if (profile.suspended) {
      throw new Error("This organizer account is suspended. Contact support.");
    }
    if (event.status === "cancelled") {
      throw new Error("Event is cancelled - there's no revenue to pay out.");
    }
    const cutoff = event.endsAt ?? event.startsAt;
    if (Date.now() >= cutoff) {
      throw new Error("This event has already ended - its payout happens automatically now.");
    }
    if (!event.organizerPayoutPhone) {
      throw new Error("Add a payout phone number to this event before requesting a payout.");
    }

    const existingPending = await ctx.db
      .query("payoutRequests")
      .withIndex("by_event_status", (q) => q.eq("eventId", eventId).eq("status", "pending"))
      .first();
    if (existingPending) {
      throw new Error("You already have a pending payout request for this event.");
    }

    const eligibleGHS: number = await ctx.runQuery(api.payouts.eligiblePayoutAmount, { eventId });
    if (amountGHS <= 0) {
      throw new Error("Requested amount must be greater than 0.");
    }
    if (amountGHS > eligibleGHS) {
      throw new Error(`Amount exceeds your eligible balance of GHS ${eligibleGHS}.`);
    }

    return await ctx.db.insert("payoutRequests", {
      eventId,
      organizerClerkUserId: identity.subject,
      organizerPayoutPhone: event.organizerPayoutPhone,
      amountGHS,
      status: "pending",
      eligibleGHSAtRequest: eligibleGHS,
      requestedAt: Date.now(),
    });
  },
});

async function attemptMoolreTransfer(params: {
  payoutId: any;
  organizerPayoutPhone: string;
  amountGHS: number;
  channel: string;
  externalRefTag?: string;
}): Promise<{ accepted: boolean; externalref: string; failureReason?: string }> {
  const { payoutId, organizerPayoutPhone, amountGHS, channel, externalRefTag } = params;

  // Channel-suffixed so each attempt gets its own externalref - required
  // ("unique ID to identify the transfer" per Moolre's docs) and correct,
  // since a rejected attempt on one channel and a fresh attempt on another
  // are genuinely different requests, not retries of the same one.
  // externalRefTag additionally distinguishes a backup-number attempt from
  // the primary's, since both could otherwise land on the same channel
  // (e.g. the primary's own MTN number failing, backup MTN succeeding).
  const externalref = `payout:${payoutId}:${channel}${externalRefTag ? `-${externalRefTag}` : ""}`;
  const config = requireMoolreEnv([
    "MOOLRE_API_BASE",
    "MOOLRE_API_USER",
    "MOOLRE_API_KEY",
    "MOOLRE_ACCOUNT_NUMBER",
    "MOOLRE_WALLET_ID",
  ]);

  const result = await requestTransfer(config, {
    channel,
    amountGHS,
    receiver: organizerPayoutPhone,
    externalref,
  });
  return {
    accepted: result.accepted,
    externalref,
    failureReason: result.accepted ? undefined : result.message || "Payout could not be started.",
  };
}

// Tries every channel transferChannelsToTry returns for one phone number,
// stopping early on our own wallet running short (trying another channel,
// or the backup number, can't fix that) and stopping immediately on
// acceptance. Shared by the primary and backup attempts below.
async function tryTransferToPhone(
  ctx: any,
  params: { payoutId: any; phone: string; amountGHS: number; externalRefTag?: string },
): Promise<{ accepted: boolean; failureReason?: string }> {
  const { payoutId, phone, amountGHS, externalRefTag } = params;
  let lastFailureReason: string | undefined;
  for (const channel of transferChannelsToTry(phone)) {
    const result = await attemptMoolreTransfer({
      payoutId,
      organizerPayoutPhone: phone,
      amountGHS,
      channel,
      externalRefTag,
    });
    if (result.accepted) {
      await ctx.runMutation(internal.payouts.setPayoutAcceptedChannel, {
        payoutId,
        externalRef: result.externalref,
        channel,
        payoutPhoneUsed: phone,
      });
      return { accepted: true };
    }
    lastFailureReason = result.failureReason;
    if (lastFailureReason && /balance/i.test(lastFailureReason)) break;
  }
  return { accepted: false, failureReason: lastFailureReason };
}

// Shared by both the admin-triggered action below and the automatic cron
// job (autoPayoutEndedEvents) - creates the pending payout record and
// fires the real Moolre transfer. Never throws on a Moolre-side rejection
// (marks the payout "failed" and returns that instead) so a batch of
// automatic payouts can keep going after one event's transfer is
// rejected, rather than the whole cron run aborting.
//
// If the primary number's transfer is rejected, falls back once to the
// organizer's on-file backup MTN number (organizerProfiles.
// backupPayoutPhoneMtn) - required at event-creation time whenever the
// primary isn't itself MTN (see events.ts's requireBackupMtnIfNeeded), so
// this is the other half of that safety net actually paying out. Skipped
// entirely if the primary failure was our own wallet balance (a different
// number can't fix that) or if there's no organizerClerkUserId to look a
// profile up for (pre-v1 seeded/manual events).
async function sendOrganizerPayoutTransfer(
  ctx: any,
  params: {
    eventId: any;
    organizerClerkUserId?: string;
    organizerPayoutPhone: string;
    amountGHS: number;
    kind?: "interim" | "final";
  },
): Promise<{ payoutId: any; accepted: boolean; failureReason?: string }> {
  const { eventId, organizerClerkUserId, organizerPayoutPhone, amountGHS, kind } = params;

  const payoutId = await ctx.runMutation(internal.payouts.createPendingPayout, {
    eventId,
    organizerPayoutPhone,
    amountGHS,
    kind,
  });

  const primaryResult = await tryTransferToPhone(ctx, { payoutId, phone: organizerPayoutPhone, amountGHS });
  if (primaryResult.accepted) return { payoutId, accepted: true };

  const isBalanceIssue = Boolean(primaryResult.failureReason && /balance/i.test(primaryResult.failureReason));
  let backupResult: { accepted: boolean; failureReason?: string } | undefined;

  if (!isBalanceIssue && organizerClerkUserId) {
    const profile = await ctx.runQuery(internal.payouts.getOrganizerBackupPayoutPhone, { organizerClerkUserId });
    const backupPhone = profile?.backupPayoutPhoneMtn;
    if (backupPhone && backupPhone !== organizerPayoutPhone) {
      backupResult = await tryTransferToPhone(ctx, {
        payoutId,
        phone: backupPhone,
        amountGHS,
        externalRefTag: "backup",
      });
      if (backupResult.accepted) return { payoutId, accepted: true };
    }
  }

  await ctx.runMutation(internal.payouts.markPayoutFailed, { payoutId });
  return {
    payoutId,
    accepted: false,
    failureReason: backupResult?.failureReason || primaryResult.failureReason || "Payout could not be started.",
  };
}

async function payoutEventIfDue(
  ctx: any,
  params: {
    eventId: any;
    actor: AdminIdentity;
    overrideAmountGHS?: number;
    strict: boolean;
    alertPrefix?: string;
  },
): Promise<{ status: string; amountGHS?: number; reason?: string }> {
  const { eventId, actor, overrideAmountGHS, strict, alertPrefix } = params;

  const event = await ctx.runQuery(api.events.getById, { eventId });
  if (!event) {
    if (strict) throw new Error("Event not found");
    return { status: "skipped", reason: "event_not_found" };
  }
  if (event.status === "cancelled") {
    if (strict) throw new Error("Event is cancelled - resolve refunds before paying out.");
    return { status: "skipped", reason: "cancelled" };
  }

  const cutoff = event.endsAt ?? event.startsAt;
  if (Date.now() < cutoff) {
    if (strict) throw new Error("Event hasn't ended yet - revenue isn't eligible for payout until then.");
    return { status: "not_due" };
  }

  const eligibleGHS: number = await ctx.runQuery(api.payouts.eligiblePayoutAmount, { eventId });
  const amountGHS = overrideAmountGHS ?? eligibleGHS;
  if (amountGHS <= 0) {
    // Only settle off of the real eligible figure, not an admin override -
    // an override of 0 while eligibleGHS is still positive means real money
    // is still owed, just not being paid out right now.
    if (eligibleGHS <= 0) {
      await ctx.runMutation(internal.payouts.markPayoutSettledIfUnset, { eventId });
    }
    return { status: "nothing_due", amountGHS: 0 };
  }

  if (!strict) {
    const hasRecentFailure: boolean = await ctx.runQuery(internal.payouts.hasRecentFailedPayout, {
      eventId,
      since: Date.now() - AUTO_PAYOUT_FAILED_RETRY_DELAY_MS,
    });
    if (hasRecentFailure) {
      return { status: "deferred", amountGHS, reason: "recent_failed_payout" };
    }

    // Each real attempt above already alerts on its own failure (see
    // sendOrganizerPayoutTransfer's caller below and autoPayoutSingleEvent's
    // catch block) - that's the signal for a human to fix the payout
    // details, so this just stops the retries once it's clearly not a
    // transient problem, rather than alerting again here too.
    const failedAttempts: number = await ctx.runQuery(internal.payouts.countFailedPayoutAttempts, {
      eventId,
      limit: MAX_AUTO_PAYOUT_ATTEMPTS,
    });
    if (failedAttempts >= MAX_AUTO_PAYOUT_ATTEMPTS) {
      return { status: "blocked", amountGHS, reason: "max_auto_retry_attempts_reached" };
    }
  }

  if (!event.organizerPayoutPhone) {
    const message = "Event has no organizer payout phone on file.";
    if (strict) throw new Error(message);
    return { status: "skipped", amountGHS, reason: "missing_payout_phone" };
  }

  const result = await sendOrganizerPayoutTransfer(ctx, {
    eventId,
    organizerClerkUserId: event.organizerClerkUserId,
    organizerPayoutPhone: event.organizerPayoutPhone,
    amountGHS,
  });

  await ctx.runMutation(internal.payouts.logPayoutInitiated, {
    payoutId: result.payoutId,
    adminSubject: actor.subject,
    adminLabel: actor.label,
    eventId,
    amountGHS,
    wasOverride: overrideAmountGHS !== undefined,
    eligibleGHS,
  });

  if (!result.accepted) {
    const message = result.failureReason || "Payout could not be started.";
    if (alertPrefix) {
      await alertCritical(alertPrefix, `Event ${event._id} ("${event.title}"): ${message}`);
    }
    if (strict) throw new Error(message);
    return { status: "failed", amountGHS, reason: message };
  }

  return { status: "initiated", amountGHS };
}

// Admin-triggered escrow release - lets an admin pay out a specific event
// on demand (e.g. to correct something the automatic run got wrong, or
// before the next scheduled run), from the God Mode console's Payouts tab.
export const initiateOrganizerPayout = action({
  args: {
    eventId: v.id("events"),
    // Rare manual correction when the automatic eligibility math is known
    // to be wrong for this event (e.g. a prior off-platform settlement) -
    // logged explicitly so it's clearly not the computed figure.
    overrideAmountGHS: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { eventId, overrideAmountGHS },
  ): Promise<{ status: string; amountGHS?: number }> => {
    const admin = await requireAdmin(ctx);
    return await payoutEventIfDue(ctx, {
      eventId,
      actor: admin,
      overrideAmountGHS,
      strict: true,
    });
  },
});

// Browser-safe manual trigger: the admin console queues the real network
// transfer as a server-side action and returns immediately, so the browser
// connection is not holding the Moolre transfer open.
export const queueOrganizerPayout = mutation({
  args: {
    eventId: v.id("events"),
    overrideAmountGHS: v.optional(v.number()),
  },
  handler: async (ctx, { eventId, overrideAmountGHS }) => {
    const admin = await requireAdmin(ctx);
    const event = await ctx.db.get(eventId);
    if (!event) throw new Error("Event not found.");
    if (event.status === "cancelled") {
      throw new Error("Event is cancelled - resolve refunds before paying out.");
    }
    if (!event.organizerPayoutPhone) {
      throw new Error("Event has no organizer payout phone on file.");
    }
    const cutoff = event.endsAt ?? event.startsAt;
    if (Date.now() < cutoff) {
      throw new Error("Event hasn't ended yet - revenue isn't eligible for payout until then.");
    }
    if (overrideAmountGHS !== undefined && overrideAmountGHS <= 0) {
      throw new Error("Override payout amount must be greater than 0.");
    }

    await ctx.scheduler.runAfter(0, internal.payouts.runQueuedOrganizerPayout, {
      eventId,
      overrideAmountGHS,
      adminSubject: admin.subject,
      adminLabel: admin.label,
    });

    await logAdminAction(ctx, admin, {
      action: "payout.queue",
      targetType: "event",
      targetId: eventId,
      details: { overrideAmountGHS },
    });

    return { status: "queued" };
  },
});

export const runQueuedOrganizerPayout = internalAction({
  args: {
    eventId: v.id("events"),
    overrideAmountGHS: v.optional(v.number()),
    adminSubject: v.string(),
    adminLabel: v.string(),
  },
  handler: async (ctx, { eventId, overrideAmountGHS, adminSubject, adminLabel }) => {
    try {
      await payoutEventIfDue(ctx, {
        eventId,
        actor: { subject: adminSubject, label: adminLabel },
        overrideAmountGHS,
        strict: true,
      });
    } catch (err) {
      await alertCritical(
        "Queued payout failed",
        `Event ${eventId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  },
});

// Admin God Mode: review an organizer's interim-payout request. Approving
// doesn't move money synchronously - it queues the real transfer as a
// server-side action (same "browser-safe" shape as queueOrganizerPayout
// below) via the shared sendOrganizerPayoutTransfer, tagged kind:"interim"
// so it's distinguishable from an automatic/admin end-of-event payout in
// the Payouts tab.
export const approvePayoutRequest = mutation({
  args: { requestId: v.id("payoutRequests") },
  handler: async (ctx, { requestId }) => {
    const admin = await requireAdmin(ctx);
    const request = await ctx.db.get(requestId);
    if (!request) throw new Error("Payout request not found.");
    if (request.status !== "pending") {
      throw new Error("This request has already been decided.");
    }

    // Defensive re-check - the eligible balance could have shifted since
    // the organizer submitted the request (e.g. an order was refunded).
    const eligibleGHS: number = await ctx.runQuery(api.payouts.eligiblePayoutAmount, {
      eventId: request.eventId,
    });
    if (request.amountGHS > eligibleGHS) {
      throw new Error(
        `Requested amount (GHS ${request.amountGHS}) now exceeds the event's eligible balance (GHS ${eligibleGHS}).`,
      );
    }

    await ctx.scheduler.runAfter(0, internal.payouts.runApprovedInterimPayout, {
      requestId,
      adminSubject: admin.subject,
      adminLabel: admin.label,
    });

    await logAdminAction(ctx, admin, {
      action: "payoutRequest.approve",
      targetType: "payoutRequest",
      targetId: requestId,
      details: { eventId: request.eventId, amountGHS: request.amountGHS },
    });

    return { status: "queued" };
  },
});

export const runApprovedInterimPayout = internalAction({
  args: {
    requestId: v.id("payoutRequests"),
    adminSubject: v.string(),
    adminLabel: v.string(),
  },
  handler: async (ctx, { requestId, adminSubject, adminLabel }) => {
    const request = await ctx.runQuery(internal.payouts.getPayoutRequestInternal, { requestId });
    if (!request || request.status !== "pending") return;

    // Bypasses payoutEventIfDue entirely on purpose - this is an explicit,
    // one-off admin-approved transfer for an in-flight event, not the
    // automatic end-of-event sweep, so neither the endsAt cutoff nor the
    // recent-failure backoff apply here.
    const result = await sendOrganizerPayoutTransfer(ctx, {
      eventId: request.eventId,
      organizerClerkUserId: request.organizerClerkUserId,
      organizerPayoutPhone: request.organizerPayoutPhone,
      amountGHS: request.amountGHS,
      kind: "interim",
    });

    await ctx.runMutation(internal.payouts.applyPayoutRequestApproval, {
      requestId,
      payoutId: result.payoutId,
      adminSubject,
      adminLabel,
    });

    if (!result.accepted) {
      await alertCritical(
        "Interim payout approved but transfer failed",
        `Request ${requestId} (event ${request.eventId}): ${result.failureReason || "Payout could not be started."}`,
      );
    }
  },
});

export const getPayoutRequestInternal = internalQuery({
  args: { requestId: v.id("payoutRequests") },
  handler: async (ctx, { requestId }) => ctx.db.get(requestId),
});

export const applyPayoutRequestApproval = internalMutation({
  args: {
    requestId: v.id("payoutRequests"),
    payoutId: v.id("payouts"),
    adminSubject: v.string(),
    adminLabel: v.string(),
  },
  handler: async (ctx, { requestId, payoutId, adminSubject, adminLabel }) => {
    await ctx.db.patch(requestId, {
      status: "approved",
      payoutId,
      decidedAt: Date.now(),
      decidedByAdminId: adminSubject,
      decidedByAdminLabel: adminLabel,
    });
  },
});

export const rejectPayoutRequest = mutation({
  args: { requestId: v.id("payoutRequests"), reason: v.string() },
  handler: async (ctx, { requestId, reason }) => {
    const admin = await requireAdmin(ctx);
    const trimmedReason = reason.trim();
    if (!trimmedReason) throw new Error("A reason is required.");

    const request = await ctx.db.get(requestId);
    if (!request) throw new Error("Payout request not found.");
    if (request.status !== "pending") {
      throw new Error("This request has already been decided.");
    }

    await ctx.db.patch(requestId, {
      status: "rejected",
      rejectionReason: trimmedReason,
      decidedAt: Date.now(),
      decidedByAdminId: admin.subject,
      decidedByAdminLabel: admin.label,
    });

    await logAdminAction(ctx, admin, {
      action: "payoutRequest.reject",
      targetType: "payoutRequest",
      targetId: requestId,
      reason: trimmedReason,
    });
  },
});

export const autoPayoutSingleEvent = internalAction({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    try {
      await payoutEventIfDue(ctx, {
        eventId,
        actor: SYSTEM_IDENTITY,
        strict: false,
        alertPrefix: "Automatic payout failed",
      });
    } catch (err) {
      await alertCritical(
        "Automatic payout failed",
        `Event ${eventId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
});

// Cron-triggered (see convex/crons.ts) - finds every non-cancelled event
// that has ended and still has eligible revenue, and pays it out
// automatically with no admin action needed. eligiblePayoutAmount already
// subtracts any payout that's pending or paid for an event, so re-running
// this against the same event a second time is safe - it naturally sees
// nothing left to pay out and skips it.
export const autoPayoutEndedEvents = internalAction({
  args: {},
  handler: async (ctx) => {
    const events = await ctx.runQuery(internal.payouts.listEventsDueForAutoPayout, {});

    for (const event of events) {
      try {
        await payoutEventIfDue(ctx, {
          eventId: event._id,
          actor: SYSTEM_IDENTITY,
          strict: false,
          alertPrefix: "Automatic payout failed",
        });
      } catch (err) {
        // One event's transfer failing (bad phone number, Moolre outage,
        // etc.) shouldn't stop the rest of the batch - each is independent
        // money movement to a different organizer.
        await alertCritical(
          "Automatic payout failed",
          `Event ${event._id} ("${event.title}"): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  },
});

// Was an unindexed .collect() over the entire events table, run every
// minute - the single largest constant (traffic-independent) source of
// Convex bandwidth usage in this app. Only a published event can ever
// have real paid orders to pay out (a draft/other-status event has never
// been sellable), and (endsAt ?? startsAt) <= now always implies
// startsAt <= now (endsAt, when set, is never before startsAt) - so
// scoping to status="published" and startsAt<=now via the existing
// by_status_startsAt index is a safe narrowing, not just a performance
// tweak: nothing that could actually be due for payout falls outside it.
export const listEventsDueForAutoPayout = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const events = await ctx.db
      .query("events")
      .withIndex("by_status_startsAt", (q) => q.eq("status", "published").lte("startsAt", now))
      .collect();
    return events.filter(
      (event) =>
        event.payoutSettledAt === undefined &&
        Boolean(event.organizerPayoutPhone) &&
        (event.endsAt ?? event.startsAt) <= now,
    );
  },
});

// Marks an event as having nothing left to pay out, so the sweep above
// stops re-scanning its full orders/payouts history on every run. This was
// the single largest source of Convex Database I/O in the app: the sweep
// re-checked every published+started event's revenue forever, even ones
// paid out months ago. Idempotent (checked, not just overwritten) so a
// concurrent settle doesn't reset the timestamp pointlessly.
export const markPayoutSettledIfUnset = internalMutation({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const event = await ctx.db.get(eventId);
    if (!event || event.payoutSettledAt !== undefined) return;
    await ctx.db.patch(eventId, { payoutSettledAt: Date.now() });
  },
});

export const hasRecentFailedPayout = internalQuery({
  args: {
    eventId: v.id("events"),
    since: v.number(),
  },
  handler: async (ctx, { eventId, since }) => {
    // Indexed directly to "failed rows for this event created since X",
    // stopping at the first match - a full by_event scan here would re-read
    // every past failure on each retry, growing with the event's own
    // failure count instead of staying flat.
    const recent = await ctx.db
      .query("payouts")
      .withIndex("by_event_status_created", (q) =>
        q.eq("eventId", eventId).eq("status", "failed").gte("createdAt", since),
      )
      .first();
    return recent !== null;
  },
});

// Bounded to `limit` reads regardless of how many times this event's
// payout has actually failed - .take() stops the index scan early instead
// of collecting the whole (potentially hundreds-deep) failure history.
export const countFailedPayoutAttempts = internalQuery({
  args: {
    eventId: v.id("events"),
    limit: v.number(),
  },
  handler: async (ctx, { eventId, limit }) => {
    const failed = await ctx.db
      .query("payouts")
      .withIndex("by_event_status_created", (q) => q.eq("eventId", eventId).eq("status", "failed"))
      .take(limit);
    return failed.length;
  },
});

export const createPendingPayout = internalMutation({
  args: {
    eventId: v.id("events"),
    organizerPayoutPhone: v.string(),
    amountGHS: v.number(),
    kind: v.optional(v.union(v.literal("interim"), v.literal("final"))),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("payouts", {
      ...args,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

export const markPayoutFailed = internalMutation({
  args: { payoutId: v.id("payouts") },
  handler: async (ctx, { payoutId }) => {
    await ctx.db.patch(payoutId, { status: "failed" });
  },
});

// Records which channel/externalref Moolre actually accepted, once one of
// sendOrganizerPayoutTransfer's channel attempts succeeds - needed because
// the winning channel isn't necessarily the prefix-guessed one, and later
// status verification (webhook or the verifyPendingPayouts sweep) has to
// use the exact externalref that was accepted, not a reconstructed guess.
export const setPayoutAcceptedChannel = internalMutation({
  args: {
    payoutId: v.id("payouts"),
    externalRef: v.string(),
    channel: v.string(),
    payoutPhoneUsed: v.optional(v.string()),
  },
  handler: async (ctx, { payoutId, externalRef, channel, payoutPhoneUsed }) => {
    await ctx.db.patch(payoutId, { externalRef, channel, payoutPhoneUsed });
  },
});

// Looked up live (not snapshotted onto events/payoutRequests) so an
// organizer correcting their backup number takes effect on the very next
// payout attempt, not just future events.
export const getOrganizerBackupPayoutPhone = internalQuery({
  args: { organizerClerkUserId: v.string() },
  handler: async (ctx, { organizerClerkUserId }) => {
    const profile = await ctx.db
      .query("organizerProfiles")
      .withIndex("by_organizer", (q) => q.eq("organizerClerkUserId", organizerClerkUserId))
      .unique();
    return profile ? { backupPayoutPhoneMtn: profile.backupPayoutPhoneMtn } : null;
  },
});

export const logPayoutInitiated = internalMutation({
  args: {
    payoutId: v.id("payouts"),
    adminSubject: v.string(),
    adminLabel: v.string(),
    eventId: v.id("events"),
    amountGHS: v.number(),
    wasOverride: v.boolean(),
    eligibleGHS: v.number(),
  },
  handler: async (ctx, args) => {
    await logAdminAction(ctx, { subject: args.adminSubject, label: args.adminLabel }, {
      action: "payout.initiate",
      targetType: "payout",
      targetId: args.payoutId,
      details: {
        eventId: args.eventId,
        amountGHS: args.amountGHS,
        wasOverride: args.wasOverride,
        eligibleGHS: args.eligibleGHS,
      },
    });
  },
});

// Admin God Mode: manual override for out-of-band settlement (e.g. a
// bank transfer made outside Moolre because a transfer was rejected) -
// bypasses the normal pending->paid verification flow entirely, so it's
// audit-logged with a mandatory reason rather than just a status field.
export const adminSetPayoutStatus = mutation({
  args: {
    payoutId: v.id("payouts"),
    status: v.union(v.literal("paid"), v.literal("failed")),
    reason: v.string(),
  },
  handler: async (ctx, { payoutId, status, reason }) => {
    const admin = await requireAdmin(ctx);
    const trimmedReason = reason.trim();
    if (!trimmedReason) throw new Error("A reason is required.");

    const payout = await ctx.db.get(payoutId);
    if (!payout) throw new Error("Payout not found.");

    await ctx.db.patch(payoutId, {
      status,
      paidAt: status === "paid" ? Date.now() : payout.paidAt,
    });

    await logAdminAction(ctx, admin, {
      action: "payout.manualStatus",
      targetType: "payout",
      targetId: payoutId,
      reason: trimmedReason,
      details: { previousStatus: payout.status, newStatus: status },
    });
  },
});

// Called from convex/http.ts, mirroring convex/moolre.ts's
// verifyAndProcessPayment - the webhook is just a "check now" nudge, we
// never trust its body, we re-fetch the authoritative status from
// Moolre's own status endpoint before marking a payout paid.
export const verifyAndProcessPayout = internalAction({
  args: { externalref: v.string(), payoutId: v.id("payouts") },
  handler: async (ctx, { externalref, payoutId }): Promise<void> => {
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
      // Real money left the platform (a transfer to an organizer) and we
      // can't confirm it went through - worth a human looking at
      // promptly, not just a routine failure.
      await alertCritical(
        "Moolre payout status check failed",
        `Could not verify payout status for payout ${payoutId} (externalref ${externalref}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    await ctx.runMutation(internal.payouts.applyVerifiedPayoutStatus, {
      payoutId,
      isSuccess: isMoolreAccepted(txstatus),
      // Moolre's own Transfer Status docs document txstatus 1=Successful,
      // 0=Pending, 2=Failed, 3=Unknown - confirmed for real against a
      // transfer that sat "Pending" for hours before Moolre's own side
      // resolved it to 2. Only 2 is treated as definite; 0/3 stay pending
      // rather than guess.
      isDefiniteFailure: txstatus === 2,
      transactionId,
    });
  },
});

export const applyVerifiedPayoutStatus = internalMutation({
  args: {
    payoutId: v.id("payouts"),
    isSuccess: v.boolean(),
    isDefiniteFailure: v.optional(v.boolean()),
    transactionId: v.optional(v.string()),
  },
  handler: async (ctx, { payoutId, isSuccess, isDefiniteFailure, transactionId }) => {
    const payout = await ctx.db.get(payoutId);
    if (!payout || payout.status !== "pending") return;

    if (isSuccess) {
      await ctx.db.patch(payoutId, {
        status: "paid",
        moolreReference: transactionId,
        paidAt: Date.now(),
      });
      await ctx.scheduler.runAfter(0, internal.payouts.sendPayoutNotification, { payoutId });
      return;
    }

    if (!isDefiniteFailure) {
      // Genuinely unclear (still pending on Moolre's side, or an
      // undocumented status) - leave it pending rather than guess. A
      // stuck "pending" payout is a support/ops question, not something
      // to silently resolve.
      return;
    }

    await ctx.db.patch(payoutId, { status: "failed" });

    // This payout's amount was counted as "already accounted for" while
    // pending (see eligiblePayoutAmount), which can make the automatic
    // sweep believe the event has nothing left to pay out and mark it
    // settled. Now that Moolre has confirmed the money never actually
    // moved, un-settle the event so the sweep picks it back up and
    // retries - same pattern as a late-arriving paid order (see
    // moolre/webhook.ts's applyVerifiedStatus).
    const event = await ctx.db.get(payout.eventId);
    if (event?.payoutSettledAt !== undefined) {
      await ctx.db.patch(payout.eventId, { payoutSettledAt: undefined });
    }

    await alertCritical(
      "Moolre payout confirmed failed after being pending",
      `Payout ${payoutId} for event ${payout.eventId} (GHS ${payout.amountGHS} to ${payout.organizerPayoutPhone}) was confirmed FAILED by Moolre (txstatus 2) after sitting pending. Marked failed and re-queued the event for automatic retry.`,
    );
  },
});

export const getPayoutInternal = internalQuery({
  args: { payoutId: v.id("payouts") },
  handler: async (ctx, { payoutId }) => ctx.db.get(payoutId),
});

// Cron-triggered (see convex/crons.ts) - verifyAndProcessPayout above is
// otherwise only ever called from the Moolre webhook (http.ts), so a
// payout whose webhook callback is delayed, dropped, or never registered
// stays "pending" forever with nobody re-checking it - real money that
// already left the platform, with no confirmation it arrived. Mirrors
// serviceFees.ts's verifyPendingServiceFeeTransfers, which has the same
// webhook-as-only-path gap already closed for service-fee transfers.
export const listPendingPayouts = internalQuery({
  args: { olderThan: v.number(), limit: v.number() },
  handler: async (ctx, { olderThan, limit }): Promise<Doc<"payouts">[]> => {
    return await ctx.db
      .query("payouts")
      .withIndex("by_status_created", (q) => q.eq("status", "pending").lt("createdAt", olderThan))
      .take(limit);
  },
});

export const verifyPendingPayouts = internalAction({
  args: {},
  handler: async (ctx): Promise<{ status: string; checked: number }> => {
    const payouts: Doc<"payouts">[] = await ctx.runQuery(internal.payouts.listPendingPayouts, {
      // Give the webhook a couple of minutes to land normally before this
      // sweep duplicates the same status check.
      olderThan: Date.now() - 2 * 60 * 1000,
      limit: 40,
    });

    for (const payout of payouts) {
      // Falls back to the old (pre-channel-fallback) externalref shape for
      // rows created before this field existed.
      await ctx.runAction(internal.payouts.verifyAndProcessPayout, {
        externalref: payout.externalRef ?? `payout:${payout._id}`,
        payoutId: payout._id,
      });
    }

    return { status: "ok", checked: payouts.length };
  },
});

// Lets an organizer know their money actually moved, rather than having
// to check the dashboard - mirrors the buyer confirmation and sale
// notification emails in convex/moolre.ts.
export const sendPayoutNotification = internalAction({
  args: { payoutId: v.id("payouts") },
  handler: async (ctx, { payoutId }) => {
    const payout = await ctx.runQuery(internal.payouts.getPayoutInternal, { payoutId });
    if (!payout) return;

    const contact = await ctx.runQuery(internal.events.getOrganizerContactForEvent, {
      eventId: payout.eventId,
    });
    if (!contact) return;

    const event = await ctx.runQuery(api.events.getById, { eventId: payout.eventId });
    const eventTitle = event?.title ?? "your event";

    await sendBrevoEmail({
      sender: SENDERS.events,
      to: [{ email: contact.contactEmail, name: contact.organizerName }],
      subject: `Payout sent: ${eventTitle}`,
      htmlContent: renderEmailLayout({
        heading: "Your payout is on its way",
        bodyHtml:
          paragraph(`Hi ${escapeHtml(contact.organizerName)},`) +
          paragraph(
            `GHS ${payout.amountGHS} for <strong>${escapeHtml(eventTitle)}</strong> has been sent to your Mobile Money number on file.`,
          ),
        footerNote: "This confirms an organizer payout from Nsaa Tickets.",
      }),
    });
  },
});
