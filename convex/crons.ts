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

export default crons;
