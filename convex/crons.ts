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

export default crons;
