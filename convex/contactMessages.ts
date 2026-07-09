import { mutation } from "./_generated/server";
import { v } from "convex/values";

export const create = mutation({
  args: {
    name: v.string(),
    email: v.string(),
    topic: v.union(
      v.literal("support"),
      v.literal("payments"),
      v.literal("press"),
      v.literal("partnerships"),
      v.literal("other"),
    ),
    message: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("contactMessages", {
      ...args,
      status: "new",
      createdAt: Date.now(),
    });
  },
});
