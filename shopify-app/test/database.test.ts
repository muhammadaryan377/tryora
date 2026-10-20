import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { PreviewService } from "../app/core/index";

// Opt in explicitly; never use the application's DATABASE_URL for integration tests.
const target = process.env.TRYORA_TEST_DATABASE_URL;
describe.skipIf(!target)("isolated PostgreSQL persistence", () => {
  let db: PrismaClient;
  let service: PreviewService;
  const shopId = `${randomUUID()}.myshopify.com`;
  const input = () => ({ shopId, productId: "gid://shopify/Product/1", optionValue: "Blue", visitorId: randomUUID(), idempotencyKey: randomUUID(), referenceVersion: "v1", roomPhotoHash: "hash", leadStepDone: true });

  beforeAll(async () => {
    const url = new URL(target!);
    if (!["127.0.0.1", "localhost"].includes(url.hostname) || !/^\/tryora_test_[a-z0-9_]+$/.test(url.pathname)) {
      throw new Error("Integration tests require a local database named tryora_test_*");
    }
    vi.stubEnv("DATABASE_URL", target!);
    db = (await import("../app/db.server")).default;
    service = (await import("../app/tryora.server")).tryora;
    await db.shop.create({ data: { id: shopId } });
    await service.grantTrial(shopId);
  });
  afterAll(async () => {
    if (db) { await db.shop.deleteMany({ where: { id: shopId } }); await db.$disconnect(); }
    vi.unstubAllEnvs();
  });

  it("settles credit and creates one analytics event under concurrent acknowledgements", async () => {
    const { job } = await service.createPreview(input());
    await service.transition(job.id, "GENERATING", { attempts: 1 });
    await service.transition(job.id, "CHECKING_RESULT", { providerRequestId: "request", costMicros: 17 });
    const ready = await service.markReadyToDeliver(job.id, 19);
    const { acknowledge } = await import("../app/storefront.server");
    await Promise.all([acknowledge(shopId, job.id, ready.job.deliveryToken!), acknowledge(shopId, job.id, ready.job.deliveryToken!)]);
    expect(await db.creditLedgerEntry.count({ where: { jobId: job.id, type: "CONSUME" } })).toBe(1);
    expect(await db.event.count({ where: { shopId, jobId: job.id, name: "delivered" } })).toBe(1);
    expect(await db.previewJob.findUnique({ where: { id: job.id } })).toMatchObject({ state: "DELIVERED", providerRequestId: "request", costMicros: 19 });
  });
  it("releases orphaned database reservations and quota exactly once", async () => {
    const { job } = await service.createPreview(input());
    expect(await service.expireStale(0)).toBe(1);
    expect(await service.expireStale(0)).toBe(0);
    expect(await db.creditLedgerEntry.count({ where: { jobId: job.id, type: "RELEASE" } })).toBe(1);
    expect(await db.quotaUsage.findUnique({ where: { jobId: job.id } })).toMatchObject({ state: "RELEASED" });
  });
  it("persists failed-attempt and photo-check usage in the additive schema", async () => {
    const usage = await db.providerUsage.create({ data: { shopId, stage: "photo_check", outcome: "failed", costMicros: null } });
    expect(await db.providerUsage.findUnique({ where: { id: usage.id } })).toMatchObject({ shopId, stage: "photo_check", costMicros: null, jobId: null });
  });
});
