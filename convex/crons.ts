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

// Pays organizers out automatically once their event ends - no admin
// click needed. Safe to run repeatedly: eligiblePayoutAmount already
// nets out any payout that's pending or paid, so an event with nothing
// left owed is a no-op every subsequent run.
crons.interval(
  "auto payout ended events",
  { hours: 1 },
  internal.payouts.autoPayoutEndedEvents,
);

export default crons;
