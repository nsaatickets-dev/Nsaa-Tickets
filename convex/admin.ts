import { v } from "convex/values";
import { query, type QueryCtx, type MutationCtx } from "./_generated/server";

// Legacy gate for the handful of pre-existing CLI-only debug utilities
// (tickets:debugCreatePaidTestOrder, events:seedDemoEvent/deleteSeedData)
// that have no UI and aren't part of the admin dashboard. New admin-gated
// functions should use requireAdmin below instead - see its comment for why.
export function requireAdminSecret(providedSecret: string | undefined) {
  const expected = process.env.ADMIN_SECRET;
  if (!expected) {
    throw new Error(
      "ADMIN_SECRET is not configured on this deployment - set one with `npx convex env set ADMIN_SECRET $(openssl rand -hex 32)` before calling admin functions.",
    );
  }
  if (providedSecret !== expected) {
    throw new Error("Invalid admin secret.");
  }
}

export type AdminIdentity = {
  subject: string;
  label: string;
};

// The real admin gate for the dashboard: a named allowlist of Clerk user
// IDs (ADMIN_CLERK_USER_IDS, comma-separated) checked against the caller's
// own verified identity, instead of a shared secret string anyone who has
// it can replay from anywhere. This means every God Mode action is
// attributable to a real signed-in person (see logAdminAction below), and
// revoking one admin doesn't require rotating a secret every other admin
// also has to re-enter.
export async function requireAdmin(ctx: QueryCtx | MutationCtx): Promise<AdminIdentity> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("Sign in required.");
  }

  const allowlist = (process.env.ADMIN_CLERK_USER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (allowlist.length === 0) {
    throw new Error(
      "ADMIN_CLERK_USER_IDS is not configured on this deployment - set it with `npx convex env set ADMIN_CLERK_USER_IDS \"user_abc,user_def\"` (see your own id below once signed in).",
    );
  }

  if (!allowlist.includes(identity.subject)) {
    throw new Error("This account is not on the admin allowlist.");
  }

  return {
    subject: identity.subject,
    label: identity.name || identity.email || identity.subject,
  };
}

// Lets the admin dashboard show "you're signed in as X, ask an existing
// admin to add this id" without needing the allowlist itself - keeps the
// bootstrap step self-service instead of requiring someone to already have
// backend access to tell a new admin their own Clerk user id.
export const whoAmI = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    return { subject: identity.subject, label: identity.name || identity.email || identity.subject };
  },
});

// Every God Mode mutation calls this right after requireAdmin so there's
// always an attributable, reviewable trail of who did what to which
// record and why - the previous shared-secret model had no such record at
// all. `details` is caller-supplied plain data (never secrets/tokens),
// stored as JSON for display in the Audit Log tab.
export async function logAdminAction(
  ctx: MutationCtx,
  admin: AdminIdentity,
  params: {
    action: string;
    targetType: string;
    targetId: string;
    reason?: string;
    details?: Record<string, unknown>;
  },
) {
  await ctx.db.insert("adminAuditLog", {
    adminClerkUserId: admin.subject,
    adminLabel: admin.label,
    action: params.action,
    targetType: params.targetType,
    targetId: params.targetId,
    reason: params.reason,
    detailsJson: params.details ? JSON.stringify(params.details) : undefined,
    createdAt: Date.now(),
  });
}

export const recentAuditLog = query({
  args: { targetType: v.optional(v.string()) },
  handler: async (ctx, { targetType }) => {
    await requireAdmin(ctx);

    if (targetType) {
      return await ctx.db
        .query("adminAuditLog")
        .withIndex("by_created")
        .order("desc")
        .filter((q) => q.eq(q.field("targetType"), targetType))
        .take(200);
    }

    return await ctx.db.query("adminAuditLog").withIndex("by_created").order("desc").take(200);
  },
});

export const auditLogForTarget = query({
  args: { targetType: v.string(), targetId: v.string() },
  handler: async (ctx, { targetType, targetId }) => {
    await requireAdmin(ctx);
    return await ctx.db
      .query("adminAuditLog")
      .withIndex("by_target", (q) => q.eq("targetType", targetType).eq("targetId", targetId))
      .order("desc")
      .collect();
  },
});
