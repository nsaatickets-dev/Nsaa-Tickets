// One-time post-signup survey - see schema.ts's userOnboarding comment.
// public/welcome.html is the only caller: it checks getMyStatus first and
// only renders the survey if nothing exists yet for this Clerk user.
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireNonEmpty } from "./validation";

export const getMyStatus = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    return await ctx.db
      .query("userOnboarding")
      .withIndex("by_clerk_user", (q) => q.eq("clerkUserId", identity.subject))
      .unique();
  },
});

export const submit = mutation({
  args: {
    referralSource: v.string(),
    role: v.string(),
  },
  handler: async (ctx, { referralSource, role }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Sign in required.");

    const existing = await ctx.db
      .query("userOnboarding")
      .withIndex("by_clerk_user", (q) => q.eq("clerkUserId", identity.subject))
      .unique();

    const fields = {
      referralSource: requireNonEmpty(referralSource, "Referral source", 80),
      role: requireNonEmpty(role, "Role", 80),
      skipped: false,
      completedAt: Date.now(),
    };

    if (existing) {
      await ctx.db.patch(existing._id, fields);
    } else {
      await ctx.db.insert("userOnboarding", {
        clerkUserId: identity.subject,
        ...fields,
        createdAt: Date.now(),
      });
    }
  },
});

// Declining still records a row (skipped: true) so welcome.html's
// getMyStatus check stops prompting this account going forward.
export const skip = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Sign in required.");

    const existing = await ctx.db
      .query("userOnboarding")
      .withIndex("by_clerk_user", (q) => q.eq("clerkUserId", identity.subject))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { skipped: true });
    } else {
      await ctx.db.insert("userOnboarding", {
        clerkUserId: identity.subject,
        skipped: true,
        createdAt: Date.now(),
      });
    }
  },
});
