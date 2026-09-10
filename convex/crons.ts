import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Safety-net sweep in case an individual scheduled expiry (set at
// reservation time in orders.ts) was somehow missed.
crons.interval(
  "sweep expired reservations",
  { minutes: 5 },
  internal.orders.sweepExpiredReservations,
);

// Safety-net payout sweep in case an event-end scheduled payout was missed
// during a deploy, edit race, or legacy event migration. New/updated events
// schedule their own exact end-time payout from events.ts - this is only
// a backstop, so it doesn't need minute-level precision. Was running every
// 1 minute (1,440x/day) against every published+started event forever;
// 20 minutes still catches a missed payout promptly while cutting that by
// 20x.
crons.interval(
  "auto payout ended events",
  { minutes: 20 },
  internal.payouts.autoPayoutEndedEvents,
);

// Safety-net verification for organizer payouts if Moolre's webhook
// callback is delayed or missed - without this, a payout that Moolre
// accepted but never confirmed via webhook stays "pending" forever.
// Mirrors "verify service fee transfers" below.
crons.interval(
  "verify pending organizer payouts",
  { minutes: 10 },
  internal.payouts.verifyPendingPayouts,
);

// Moves retained Nsaa service fees from the Moolre wallet into the
// configured GCB instant bank account, and backfills paid orders created
// before the account env var was configured. The real-time path already
// fires per-order right after payment (moolre.ts's applyVerifiedStatus
// schedules serviceFees.sweepServiceFeeForOrder immediately) - this is
// just a catch-up net for whatever that misses, and its query re-scans
// every paid order that's ever existed on each run (see
// listOrdersNeedingServiceFeeTransfer's comment), so a growing paid-order
// history makes this more expensive over time regardless of interval.
// 20 minutes instead of 5 cuts that recurring cost 4x with no real
// impact on how quickly a missed transfer gets caught.
crons.interval(
  "sweep service fees to GCB",
  { minutes: 20 },
  internal.serviceFees.sweepUntransferredServiceFees,
);

// Safety-net verification for service-fee bank transfers if Moolre's
// callback is delayed or missed.
crons.interval(
  "verify service fee transfers",
  { minutes: 10 },
  internal.serviceFees.verifyPendingServiceFeeTransfers,
);

// Safety-net sweep in case an individual scheduled WhatsApp event reminder
// (set at payment-confirmation time in moolre.ts) was somehow missed.
crons.interval(
  "sweep missed WhatsApp event reminders",
  { minutes: 15 },
  internal.whatsapp.sweepMissedEventReminders,
);

// Self-healing safety net for this session's root incident: the account's
// Moolre webhook callback silently pointed at a dead dev deployment for an
// unknown period, and nothing noticed until payouts/orders started
// staying stuck "pending" with no confirmation ever arriving. Re-asserting
// the same correct callback URL is a no-op when nothing's wrong, and
// fixes it automatically if a future dev-testing session forgets to
// point the callback back at prod afterward. Tightened from 24h to
// hourly after the callback drifted back to dev mid-session on 2026-09-10
// - the daily interval left too wide a window during active dev/prod
// switching. Two lightweight Moolre HTTP calls per run, no Convex
// database reads/writes - negligible against Convex's own usage limits
// even at this frequency (~720 runs/month vs. 30 before).
crons.interval(
  "reassert Moolre webhook callback",
  { hours: 1 },
  internal.moolre.diagnostics.reassertMoolreCallback,
);

export default crons;
