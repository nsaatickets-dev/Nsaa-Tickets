import { mutation } from "./_generated/server";
import { v } from "convex/values";

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
    return await ctx.db.insert("organizerInquiries", {
      ...args,
      status: "new",
      createdAt: Date.now(),
    });
  },
});
