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
// schedule their own exact end-time payout from events.ts.
crons.interval(
  "auto payout ended events",
  { minutes: 1 },
  internal.payouts.autoPayoutEndedEvents,
);

// Moves retained Nsaa service fees from the Moolre wallet into the
// configured GCB instant bank account, and backfills paid orders created
// before the account env var was configured.
crons.interval(
  "sweep service fees to GCB",
  { minutes: 5 },
  internal.serviceFees.sweepUntransferredServiceFees,
);

// Safety-net verification for service-fee bank transfers if Moolre's
// callback is delayed or missed.
crons.interval(
  "verify service fee transfers",
  { minutes: 10 },
  internal.serviceFees.verifyPendingServiceFeeTransfers,
);

export default crons;
