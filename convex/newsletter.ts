import { mutation } from "./_generated/server";
import { v } from "convex/values";

export const subscribe = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const normalized = email.trim().toLowerCase();

    const existing = await ctx.db
      .query("newsletterSubscribers")
      .withIndex("by_email", (q) => q.eq("email", normalized))
      .unique();
    if (existing) return existing._id;

    return await ctx.db.insert("newsletterSubscribers", {
      email: normalized,
      createdAt: Date.now(),
    });
  },
});
