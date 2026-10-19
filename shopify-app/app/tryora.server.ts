import type { Prisma } from "@prisma/client";
import prisma from "./db.server";
import {
  PreviewService,
  SnapshotStore,
  type LedgerEntry,
  type PreviewJob,
  type QuotaUsage,
  type ShopChanges,
  type ShopSettings,
  type ShopSnapshot,
  type SnapshotBackend,
} from "./core/index";

type Db = Prisma.TransactionClient;

const HELD_STATES = ["RESERVED", "QUEUED", "GENERATING", "CHECKING_RESULT", "READY_TO_DELIVER"];

/** Postgres backend for the engine. One database transaction per call, with a per-shop advisory lock. */
const backend: SnapshotBackend = {
  async shopIdForJob(jobId) {
    const job = await prisma.previewJob.findUnique({ where: { id: jobId }, select: { shopId: true } });
    return job?.shopId;
  },

  async shopsWithHeldJobs() {
    const rows = await prisma.previewJob.findMany({
      where: { state: { in: HELD_STATES } },
      distinct: ["shopId"],
      select: { shopId: true },
    });
    return rows.map((r) => r.shopId);
  },

  withShop(shopId, fn) {
    return prisma.$transaction(
      async (db) => {
        await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${shopId}))`;
        await db.shop.upsert({ where: { id: shopId }, create: { id: shopId }, update: {} });
        return fn({ load: () => loadShop(db, shopId), save: (c) => saveShop(db, shopId, c) });
      },
      { timeout: 15_000 },
    );
  },
};

async function loadShop(db: Db, shopId: string): Promise<ShopSnapshot> {
  const [shop, policy, ledger, jobs, quota] = await Promise.all([
    db.shop.findUnique({ where: { id: shopId } }),
    db.quotaPolicy.findUnique({ where: { shopId } }),
    db.creditLedgerEntry.findMany({ where: { shopId }, orderBy: { createdAt: "asc" } }),
    db.previewJob.findMany({ where: { shopId } }),
    db.quotaUsage.findMany({ where: { shopId } }),
  ]);
  const settings: ShopSettings | undefined = shop
    ? {
        shopId,
        leadCapture: shop.leadCapture as ShopSettings["leadCapture"],
        paidPlanActive: shop.paidPlanActive,
        quota: {
          // No saved policy yet: the recommended default (10 previews per shopper per day).
          enabled: policy ? policy.enabled : true,
          perProduct: policy?.perProduct ?? undefined,
          storeWide: policy ? (policy.storeWide ?? undefined) : 10,
          window:
            policy?.windowType === "manual" && policy.resetEpoch
              ? { type: "manual", resetEpoch: policy.resetEpoch }
              : { type: "rolling", hours: policy?.windowHours ?? 24 },
        },
      }
    : undefined;
  return {
    settings,
    ledger: ledger.map(
      (e): LedgerEntry => ({
        id: e.id,
        shopId: e.shopId,
        type: e.type as LedgerEntry["type"],
        quantity: e.quantity,
        reference: e.reference,
        bucket: (e.bucket ?? undefined) as LedgerEntry["bucket"],
        grantId: e.grantId ?? undefined,
        jobId: e.jobId ?? undefined,
        expiresAt: e.expiresAt ?? undefined,
        createdAt: e.createdAt,
      }),
    ),
    jobs: jobs.map(
      (j): PreviewJob => ({
        id: j.id,
        shopId: j.shopId,
        idempotencyKey: j.idempotencyKey,
        visitorId: j.visitorId,
        verifiedCustomerId: j.verifiedCustomerId ?? undefined,
        productId: j.productId,
        optionValue: j.optionValue,
        referenceVersion: j.referenceVersion,
        roomPhotoHash: j.roomPhotoHash,
        state: j.state as PreviewJob["state"],
        reasonCode: j.reasonCode ?? undefined,
        providerRequestId: j.providerRequestId ?? undefined,
        attempts: j.attempts,
        deliveryToken: j.deliveryToken ?? undefined,
        deliveryTokenExpiresAt: j.deliveryTokenExpiresAt ?? undefined,
        costMicros: j.costMicros,
        createdAt: j.createdAt,
        updatedAt: j.updatedAt,
        deliveredAt: j.deliveredAt ?? undefined,
        refundedAt: j.refundedAt ?? undefined,
      }),
    ),
    quota: quota.map(
      (u): QuotaUsage => ({
        jobId: u.jobId,
        shopId: u.shopId,
        visitorId: u.visitorId,
        verifiedCustomerId: u.verifiedCustomerId ?? undefined,
        productId: u.productId,
        state: u.state as QuotaUsage["state"],
        reservedAt: u.reservedAt,
        deliveredAt: u.deliveredAt ?? undefined,
      }),
    ),
  };
}

function jobData(j: PreviewJob) {
  return {
    shopId: j.shopId,
    idempotencyKey: j.idempotencyKey,
    visitorId: j.visitorId,
    verifiedCustomerId: j.verifiedCustomerId ?? null,
    productId: j.productId,
    optionValue: j.optionValue,
    referenceVersion: j.referenceVersion,
    roomPhotoHash: j.roomPhotoHash,
    state: j.state,
    reasonCode: j.reasonCode ?? null,
    providerRequestId: j.providerRequestId ?? null,
    attempts: j.attempts,
    deliveryToken: j.deliveryToken ?? null,
    deliveryTokenExpiresAt: j.deliveryTokenExpiresAt ?? null,
    costMicros: j.costMicros,
    createdAt: j.createdAt,
    deliveredAt: j.deliveredAt ?? null,
    refundedAt: j.refundedAt ?? null,
  };
}

async function saveShop(db: Db, shopId: string, c: ShopChanges) {
  if (c.settings) {
    const s = c.settings;
    await db.shop.update({
      where: { id: shopId },
      data: { leadCapture: s.leadCapture, paidPlanActive: s.paidPlanActive },
    });
    const window = s.quota.window;
    const policy = {
      enabled: s.quota.enabled,
      perProduct: s.quota.perProduct ?? null,
      storeWide: s.quota.storeWide ?? null,
      windowType: window.type,
      windowHours: window.type === "rolling" ? window.hours : 24,
      resetEpoch: window.type === "manual" ? window.resetEpoch : null,
    };
    await db.quotaPolicy.upsert({ where: { shopId }, create: { shopId, ...policy }, update: policy });
  }
  if (c.newLedger.length) {
    await db.creditLedgerEntry.createMany({
      data: c.newLedger.map((e) => ({
        id: e.id,
        shopId: e.shopId,
        type: e.type,
        quantity: e.quantity,
        reference: e.reference,
        bucket: e.bucket ?? null,
        grantId: e.grantId ?? null,
        jobId: e.jobId ?? null,
        expiresAt: e.expiresAt ?? null,
        createdAt: e.createdAt,
      })),
    });
  }
  for (const j of c.newJobs) await db.previewJob.create({ data: { id: j.id, ...jobData(j) } });
  for (const j of c.updatedJobs) await db.previewJob.update({ where: { id: j.id }, data: jobData(j) });
  for (const u of c.quota) {
    const data = {
      shopId: u.shopId,
      visitorId: u.visitorId,
      verifiedCustomerId: u.verifiedCustomerId ?? null,
      productId: u.productId,
      state: u.state,
      reservedAt: u.reservedAt,
      deliveredAt: u.deliveredAt ?? null,
    };
    await db.quotaUsage.upsert({ where: { jobId: u.jobId }, create: { jobId: u.jobId, ...data }, update: data });
  }
}

export const tryora = new PreviewService(new SnapshotStore(backend));
