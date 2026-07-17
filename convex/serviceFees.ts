import { internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { requireAdmin, logAdminAction } from "./admin";
import { alertCritical } from "./alerts";
import { requireMoolreEnv } from "./moolreConfig";

const GCB_BANK_NAME = "GCB Bank Limited";
const GCB_BANK_SUBLIST_ID = "300304";
const INSTANT_BANK_TRANSFER_CHANNEL = "2";
const DEFAULT_MIN_SWEEP_GHS = 0.01;
const FAILED_RETRY_DELAY_MS = 30 * 60 * 1000;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function isMoolreSuccess(value: unknown): boolean {
  return Number(value) === 1 || String(value ?? "").trim() === "1";
}

function moolreAccepted(data: any): boolean {
  return isMoolreSuccess(data?.status);
}

async function readMoolreJson(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_err) {
    return {
      status: response.ok ? 1 : 0,
      code: response.status,
      message: text,
    };
  }
}

function moolreMessage(data: any, fallback: string): string {
  const raw = data?.message ?? data?.msg;
  const message = Array.isArray(raw) ? raw.join(" ") : String(raw ?? "").trim();
  return message || fallback;
}

function minSweepAmount(): number {
  const configured = Number(process.env.NSAA_SERVICE_FEE_SWEEP_MIN_GHS ?? DEFAULT_MIN_SWEEP_GHS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_MIN_SWEEP_GHS;
  return Math.max(DEFAULT_MIN_SWEEP_GHS, round2(configured));
}

function serviceFeeSweepConfig():
  | {
      configured: true;
      bankAccountNumber: string;
      bankAccountLast4: string;
      bankSublistId: string;
      minAmountGHS: number;
    }
  | {
      configured: false;
      reason: "disabled" | "missing_account";
      bankSublistId: string;
      minAmountGHS: number;
    } {
  const bankSublistId = (process.env.NSAA_SERVICE_FEE_GCB_BANK_CODE ?? GCB_BANK_SUBLIST_ID).trim();
  const minAmountGHS = minSweepAmount();
  const disabled = ["0", "false", "no"].includes(
    (process.env.NSAA_SERVICE_FEE_SWEEP_ENABLED ?? "").trim().toLowerCase(),
  );
  if (disabled) {
    return { configured: false, reason: "disabled", bankSublistId, minAmountGHS };
  }

  const bankAccountNumber = (process.env.NSAA_SERVICE_FEE_GCB_ACCOUNT_NUMBER ?? "")
    .trim()
    .replace(/\s+/g, "");

  if (!bankAccountNumber) {
    return { configured: false, reason: "missing_account", bankSublistId, minAmountGHS };
  }
  if (!/^\d+$/.test(bankAccountNumber)) {
    throw new Error("NSAA_SERVICE_FEE_GCB_ACCOUNT_NUMBER must contain digits only.");
  }

  return {
    configured: true,
    bankAccountNumber,
    bankAccountLast4: bankAccountNumber.slice(-4),
    bankSublistId,
    minAmountGHS,
  };
}

function retainedServiceFeeGHS(order: {
  serviceFeeGHS: number;
  ticketSubtotalGHS: number;
  refundStatus?: string;
  refundAmountGHS?: number;
}): number {
  if (order.refundStatus === "pending") return 0;

  const refundedBeyondTicketSubtotal =
    order.refundStatus === "paid"
      ? Math.max(0, (order.refundAmountGHS ?? 0) - order.ticketSubtotalGHS)
      : 0;

  return round2(Math.max(0, order.serviceFeeGHS - refundedBeyondTicketSubtotal));
}

async function transferServiceFeeForOrder(
  ctx: any,
  orderId: Id<"orders">,
  allowRetryAfterFailure = false,
): Promise<{ status: string; amountGHS?: number; reason?: string; transferId?: Id<"serviceFeeTransfers"> }> {
  const config = serviceFeeSweepConfig();
  if (!config.configured) {
    return { status: "skipped", reason: config.reason };
  }

  const pending = await ctx.runMutation(internal.serviceFees.createPendingServiceFeeTransfer, {
    orderId,
    bankSublistId: config.bankSublistId,
    bankAccountLast4: config.bankAccountLast4,
    minAmountGHS: config.minAmountGHS,
    allowRetryAfterFailure,
  });

  if (pending.status !== "created") {
    return pending;
  }

  const moolreConfig = requireMoolreEnv([
    "MOOLRE_API_BASE",
    "MOOLRE_API_USER",
    "MOOLRE_API_KEY",
    "MOOLRE_ACCOUNT_NUMBER",
  ]);

  const response = await fetch(`${moolreConfig.MOOLRE_API_BASE}/open/transact/transfer`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-USER": moolreConfig.MOOLRE_API_USER,
      "X-API-KEY": moolreConfig.MOOLRE_API_KEY,
    },
    body: JSON.stringify({
      type: 1,
      channel: INSTANT_BANK_TRANSFER_CHANNEL,
      currency: "GHS",
      amount: String(pending.amountGHS),
      receiver: config.bankAccountNumber,
      sublistid: config.bankSublistId,
      externalref: pending.externalRef,
      reference: `Nsaa service fee ${orderId}`,
      accountnumber: moolreConfig.MOOLRE_ACCOUNT_NUMBER,
    }),
  });

  const data = await readMoolreJson(response);
  const accepted = response.ok && moolreAccepted(data);

  if (!accepted) {
    const failureReason = moolreMessage(data, "Service fee transfer could not be started.");
    await ctx.runMutation(internal.serviceFees.markServiceFeeTransferFailed, {
      transferId: pending.transferId,
      failureReason,
    });
    return {
      status: "failed",
      transferId: pending.transferId,
      amountGHS: pending.amountGHS,
      reason: failureReason,
    };
  }

  await ctx.scheduler.runAfter(60 * 1000, internal.serviceFees.verifyAndProcessServiceFeeTransfer, {
    externalref: pending.externalRef,
    transferId: pending.transferId,
  });

  return { status: "initiated", transferId: pending.transferId, amountGHS: pending.amountGHS };
}

export const serviceFeeConfigStatus = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const config = serviceFeeSweepConfig();
    return {
      configured: config.configured,
      reason: config.configured ? undefined : config.reason,
      bankName: GCB_BANK_NAME,
      bankSublistId: config.bankSublistId,
      bankAccountLast4: config.configured ? config.bankAccountLast4 : undefined,
      minAmountGHS: config.minAmountGHS,
    };
  },
});

export const serviceFeeTransferSummary = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const transfers = await ctx.db.query("serviceFeeTransfers").collect();
    const totals = {
      pendingGHS: 0,
      paidGHS: 0,
      failedGHS: 0,
      pendingCount: 0,
      paidCount: 0,
      failedCount: 0,
    };

    for (const transfer of transfers) {
      if (transfer.status === "pending") {
        totals.pendingGHS += transfer.amountGHS;
        totals.pendingCount += 1;
      } else if (transfer.status === "paid") {
        totals.paidGHS += transfer.amountGHS;
        totals.paidCount += 1;
      } else if (transfer.status === "failed") {
        totals.failedGHS += transfer.amountGHS;
        totals.failedCount += 1;
      }
    }

    return {
      pendingGHS: round2(totals.pendingGHS),
      paidGHS: round2(totals.paidGHS),
      failedGHS: round2(totals.failedGHS),
      pendingCount: totals.pendingCount,
      paidCount: totals.paidCount,
      failedCount: totals.failedCount,
    };
  },
});

export const queueServiceFeeTransfer = mutation({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    const admin = await requireAdmin(ctx);
    const order = await ctx.db.get(orderId);
    if (!order) throw new Error("Order not found.");
    if (order.paidAt === undefined) {
      throw new Error("This order has not been paid, so no service fee can be swept.");
    }

    await ctx.scheduler.runAfter(0, internal.serviceFees.sweepServiceFeeForOrder, {
      orderId,
      allowRetryAfterFailure: true,
    });

    await logAdminAction(ctx, admin, {
      action: "serviceFee.queueTransfer",
      targetType: "order",
      targetId: orderId,
      details: { serviceFeeGHS: order.serviceFeeGHS },
    });

    return { status: "queued" };
  },
});

export const sweepServiceFeeForOrder = internalAction({
  args: {
    orderId: v.id("orders"),
    allowRetryAfterFailure: v.optional(v.boolean()),
  },
  handler: async (ctx, { orderId, allowRetryAfterFailure }) => {
    try {
      const result = await transferServiceFeeForOrder(ctx, orderId, Boolean(allowRetryAfterFailure));
      if (result.status === "failed") {
        await alertCritical(
          "Service fee transfer failed",
          `Order ${orderId}: ${result.reason ?? "Moolre rejected the service fee transfer."}`,
        );
      }
      return result;
    } catch (err) {
      await alertCritical(
        "Service fee transfer failed",
        `Order ${orderId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  },
});

export const sweepUntransferredServiceFees = internalAction({
  args: {},
  handler: async (ctx) => {
    const config = serviceFeeSweepConfig();
    if (!config.configured) return { status: "skipped", reason: config.reason };

    const orderIds: Id<"orders">[] = await ctx.runQuery(
      internal.serviceFees.listOrdersNeedingServiceFeeTransfer,
      {
        minAmountGHS: config.minAmountGHS,
        failedRetryBefore: Date.now() - FAILED_RETRY_DELAY_MS,
        limit: 40,
      },
    );

    let initiated = 0;
    for (const orderId of orderIds) {
      const result = await transferServiceFeeForOrder(ctx, orderId, false);
      if (result.status === "initiated") initiated += 1;
    }

    return { status: "ok", checked: orderIds.length, initiated };
  },
});

export const verifyPendingServiceFeeTransfers = internalAction({
  args: {},
  handler: async (ctx) => {
    const transfers = await ctx.runQuery(internal.serviceFees.listPendingServiceFeeTransfers, {
      olderThan: Date.now() - 2 * 60 * 1000,
      limit: 40,
    });

    for (const transfer of transfers) {
      if (!transfer.externalRef) continue;
      await ctx.runAction(internal.serviceFees.verifyAndProcessServiceFeeTransfer, {
        externalref: transfer.externalRef,
        transferId: transfer._id,
      });
    }

    return { status: "ok", checked: transfers.length };
  },
});

export const createPendingServiceFeeTransfer = internalMutation({
  args: {
    orderId: v.id("orders"),
    bankSublistId: v.string(),
    bankAccountLast4: v.string(),
    minAmountGHS: v.number(),
    allowRetryAfterFailure: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    { orderId, bankSublistId, bankAccountLast4, minAmountGHS, allowRetryAfterFailure },
  ) => {
    const order = await ctx.db.get(orderId);
    if (!order) return { status: "skipped", reason: "order_not_found" };
    if (order.paidAt === undefined) return { status: "skipped", reason: "order_not_paid" };
    if (order.refundStatus === "pending") return { status: "skipped", reason: "refund_pending" };

    const amountGHS = retainedServiceFeeGHS(order);
    if (amountGHS <= 0) return { status: "skipped", reason: "no_retained_service_fee" };
    if (amountGHS < minAmountGHS) return { status: "skipped", reason: "below_minimum", amountGHS };

    const existing = await ctx.db
      .query("serviceFeeTransfers")
      .withIndex("by_order", (q) => q.eq("orderId", orderId))
      .collect();

    if (existing.some((transfer) => transfer.status === "pending" || transfer.status === "paid")) {
      return { status: "skipped", reason: "already_accounted" };
    }

    const newestFailed = existing
      .filter((transfer) => transfer.status === "failed")
      .sort((a, b) => b.createdAt - a.createdAt)[0];

    if (
      newestFailed &&
      !allowRetryAfterFailure &&
      newestFailed.createdAt > Date.now() - FAILED_RETRY_DELAY_MS
    ) {
      return { status: "skipped", reason: "recent_failed_transfer", amountGHS };
    }

    const transferId = await ctx.db.insert("serviceFeeTransfers", {
      orderId,
      eventId: order.eventId,
      amountGHS,
      bankSublistId,
      bankAccountLast4,
      status: "pending",
      createdAt: Date.now(),
    });
    const externalRef = `fee:${transferId}`;
    await ctx.db.patch(transferId, { externalRef });

    return { status: "created", transferId, externalRef, amountGHS };
  },
});

export const markServiceFeeTransferFailed = internalMutation({
  args: {
    transferId: v.id("serviceFeeTransfers"),
    failureReason: v.string(),
  },
  handler: async (ctx, { transferId, failureReason }) => {
    await ctx.db.patch(transferId, {
      status: "failed",
      failureReason,
    });
  },
});

export const applyVerifiedServiceFeeTransferStatus = internalMutation({
  args: {
    transferId: v.id("serviceFeeTransfers"),
    isSuccess: v.boolean(),
    transactionId: v.optional(v.string()),
  },
  handler: async (ctx, { transferId, isSuccess, transactionId }) => {
    if (!isSuccess) return;

    const transfer = await ctx.db.get(transferId);
    if (!transfer || transfer.status === "paid") return;

    await ctx.db.patch(transferId, {
      status: "paid",
      moolreReference: transactionId,
      paidAt: Date.now(),
    });
  },
});

export const verifyAndProcessServiceFeeTransfer = internalAction({
  args: { externalref: v.string(), transferId: v.id("serviceFeeTransfers") },
  handler: async (ctx, { externalref, transferId }) => {
    let txstatus: number | undefined;
    let transactionId: string | undefined;

    try {
      const config = requireMoolreEnv([
        "MOOLRE_API_BASE",
        "MOOLRE_API_USER",
        "MOOLRE_API_PUBKEY",
        "MOOLRE_ACCOUNT_NUMBER",
      ]);
      const response = await fetch(`${config.MOOLRE_API_BASE}/open/transact/status`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-USER": config.MOOLRE_API_USER,
          "X-API-PUBKEY": config.MOOLRE_API_PUBKEY,
        },
        body: JSON.stringify({
          type: 1,
          idtype: "1",
          id: externalref,
          accountnumber: config.MOOLRE_ACCOUNT_NUMBER,
        }),
      });
      const payload = await response.json();
      txstatus = payload?.data?.txstatus;
      transactionId = payload?.data?.transactionid;
    } catch (err) {
      await alertCritical(
        "Moolre service fee status check failed",
        `Could not verify service fee transfer ${transferId} (externalref ${externalref}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    await ctx.runMutation(internal.serviceFees.applyVerifiedServiceFeeTransferStatus, {
      transferId,
      isSuccess: isMoolreSuccess(txstatus),
      transactionId,
    });
  },
});

export const listOrdersNeedingServiceFeeTransfer = internalQuery({
  args: {
    minAmountGHS: v.number(),
    failedRetryBefore: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, { minAmountGHS, failedRetryBefore, limit }) => {
    const orders = (await ctx.db.query("orders").collect())
      .filter((order) => {
        if (order.paidAt === undefined || order.refundStatus === "pending") return false;
        return retainedServiceFeeGHS(order) >= minAmountGHS;
      })
      .sort((a, b) => (a.paidAt ?? 0) - (b.paidAt ?? 0));

    const orderIds: Id<"orders">[] = [];
    for (const order of orders) {
      if (orderIds.length >= limit) break;
      const transfers = await ctx.db
        .query("serviceFeeTransfers")
        .withIndex("by_order", (q) => q.eq("orderId", order._id))
        .collect();

      if (transfers.some((transfer) => transfer.status === "pending" || transfer.status === "paid")) {
        continue;
      }

      const newestFailed = transfers
        .filter((transfer) => transfer.status === "failed")
        .sort((a, b) => b.createdAt - a.createdAt)[0];

      if (newestFailed && newestFailed.createdAt > failedRetryBefore) continue;
      orderIds.push(order._id);
    }

    return orderIds;
  },
});

export const listPendingServiceFeeTransfers = internalQuery({
  args: { olderThan: v.number(), limit: v.number() },
  handler: async (ctx, { olderThan, limit }) => {
    return await ctx.db
      .query("serviceFeeTransfers")
      .withIndex("by_status_created", (q) => q.eq("status", "pending").lt("createdAt", olderThan))
      .take(limit);
  },
});
