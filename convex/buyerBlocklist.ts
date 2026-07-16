// Admin God Mode: blocks new guest-checkout reservations from a phone
// number or email. Guest checkout has no account to suspend (see
// schema.ts orders comments), so this blocklist is the only handle
// available on a bad actor - enforced in orders.ts's createReservation.
import { mutation, query, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { requireAdmin, logAdminAction } from "./admin";
import { optionalTrimmed } from "./validation";

export const listBlocklist = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return await ctx.db.query("buyerBlocklist").order("desc").collect();
  },
});

export const adminBlockBuyer = mutation({
  args: {
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
    reason: v.string(),
  },
  handler: async (ctx, { phone, email, reason }) => {
    const admin = await requireAdmin(ctx);
    const trimmedReason = reason.trim();
    if (!trimmedReason) throw new Error("A reason is required.");

    const normalizedPhone = optionalTrimmed(phone, 20)?.replace(/[\s\-()]/g, "");
    const normalizedEmail = optionalTrimmed(email, 254)?.toLowerCase();
    if (!normalizedPhone && !normalizedEmail) {
      throw new Error("Provide a phone number or email to block.");
    }

    const blocklistId = await ctx.db.insert("buyerBlocklist", {
      phone: normalizedPhone,
      email: normalizedEmail,
      reason: trimmedReason,
      createdAt: Date.now(),
      createdByAdminId: admin.subject,
    });

    await logAdminAction(ctx, admin, {
      action: "buyer.block",
      targetType: "buyerBlocklist",
      targetId: blocklistId,
      reason: trimmedReason,
      details: { phone: normalizedPhone, email: normalizedEmail },
    });
  },
});

export const adminUnblockBuyer = mutation({
  args: { blocklistId: v.id("buyerBlocklist") },
  handler: async (ctx, { blocklistId }) => {
    const admin = await requireAdmin(ctx);
    const entry = await ctx.db.get(blocklistId);
    if (!entry) throw new Error("Blocklist entry not found.");

    await ctx.db.delete(blocklistId);

    await logAdminAction(ctx, admin, {
      action: "buyer.unblock",
      targetType: "buyerBlocklist",
      targetId: blocklistId,
      details: { phone: entry.phone, email: entry.email },
    });
  },
});

// Plain helper (not a Convex function) so orders.ts's createReservation
// mutation can call it directly against its own ctx.db, same pattern as
// tickets.ts's issueTickets - no need for a runQuery round-trip when the
// caller already has full db access.
export async function isBuyerBlocked(
  ctx: { db: QueryCtx["db"] },
  phone: string,
  email: string,
): Promise<boolean> {
  const normalizedPhone = phone.replace(/[\s\-()]/g, "");
  const normalizedEmail = email.toLowerCase();

  const byPhone = await ctx.db
    .query("buyerBlocklist")
    .withIndex("by_phone", (q) => q.eq("phone", normalizedPhone))
    .first();
  if (byPhone) return true;

  const byEmail = await ctx.db
    .query("buyerBlocklist")
    .withIndex("by_email", (q) => q.eq("email", normalizedEmail))
    .first();
  return Boolean(byEmail);
}
