import { describe, expect, it } from "vitest";
import { PreviewService, TRIAL_CREDITS, type Clock, type CreatePreviewInput } from "../src/previewService.js";
import { InMemoryStore } from "../src/store.js";
import { TryoraError } from "../src/errors.js";

class TestClock implements Clock {
  constructor(public t = new Date("2026-11-01T10:00:00Z")) {}
  now() {
    return new Date(this.t);
  }
  advanceHours(h: number) {
    this.t = new Date(this.t.getTime() + h * 3600_000);
  }
}

const SHOP = "test-sofa-site.myshopify.com";
let seq = 0;
function input(over: Partial<CreatePreviewInput> = {}): CreatePreviewInput {
  return {
    shopId: SHOP,
    idempotencyKey: `key-${++seq}`,
    visitorId: "visitor-a",
    productId: "sofa-form",
    optionValue: "Oat",
    referenceVersion: "v1",
    roomPhotoHash: "room-1",
    leadStepDone: true,
    ...over,
  };
}

function setup() {
  const clock = new TestClock();
  const svc = new PreviewService(new InMemoryStore(), clock);
  return { clock, svc };
}

describe("reservation deadlines", () => {
  it("expires a reservation based on creation even when progress updates refresh updatedAt", async () => {
    const { clock, svc } = setup();
    await svc.grantTrial(SHOP);
    const { job } = await svc.createPreview(input({ workerId: "worker_process" }));
    expect(job.id).toMatch(/^worker_process__/);
    clock.advanceHours(9 / 60);
    await svc.transition(job.id, "GENERATING");
    clock.advanceHours(1 / 60);
    expect(await svc.expireStale(10 * 60_000)).toBe(1);
    expect((await svc.balance(SHOP)).availableTotal).toBe(10);
  });
  it("rejects acknowledgement exactly at token expiry and releases once", async () => {
    const { clock, svc } = setup();
    await svc.grantTrial(SHOP);
    const { job } = await svc.createPreview(input());
    await svc.transition(job.id, "GENERATING");
    await svc.transition(job.id, "CHECKING_RESULT");
    const ready = await svc.markReadyToDeliver(job.id);
    clock.advanceHours(5 / 60);
    await expectCode(svc.acknowledgeDelivery(job.id, ready.job.deliveryToken!), "BAD_TOKEN");
    expect(await svc.expireStale(10 * 60_000)).toBe(1);
    expect(await svc.expireStale(10 * 60_000)).toBe(0);
    expect((await svc.balance(SHOP)).availableTotal).toBe(10);
  });
});

/** Runs a job through to a delivered, acknowledged result. */
async function deliver(svc: PreviewService, i: CreatePreviewInput) {
  const { job } = await svc.createPreview(i);
  await svc.transition(job.id, "GENERATING");
  await svc.transition(job.id, "CHECKING_RESULT");
  const ready = await svc.markReadyToDeliver(job.id, 150_000);
  return svc.acknowledgeDelivery(job.id, ready.job.deliveryToken!);
}

async function limitsOff(svc: PreviewService) {
  const s = await svc.ensureSettings(SHOP);
  await svc.updateSettings({ ...s, quota: { ...s.quota, enabled: false } });
}

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof TryoraError && e.code === code);
}

describe("credits", () => {
  it("one valid generation consumes one credit; another colour consumes another", async () => {
    const { svc } = setup();
    await svc.grantTrial(SHOP);
    await deliver(svc, input({ optionValue: "Oat" }));
    await deliver(svc, input({ optionValue: "Olive" }));
    const b = await svc.balance(SHOP);
    expect(b.consumed).toBe(2);
    expect(b.availableTotal).toBe(TRIAL_CREDITS - 2);
  });

  it("failed or rejected output consumes no credit", async () => {
    const { svc } = setup();
    await svc.grantTrial(SHOP);
    const a = (await svc.createPreview(input())).job;
    await svc.transition(a.id, "GENERATING");
    await svc.transition(a.id, "FAILED", { reasonCode: "PROVIDER_ERROR" });
    const b = (await svc.createPreview(input())).job;
    await svc.transition(b.id, "GENERATING");
    await svc.transition(b.id, "CHECKING_RESULT");
    await svc.transition(b.id, "REJECTED", { reasonCode: "ROOM_CHANGED" });
    const bal = await svc.balance(SHOP);
    expect(bal.consumed).toBe(0);
    expect(bal.reserved).toBe(0);
    expect(bal.availableTotal).toBe(TRIAL_CREDITS);
  });

  it("two concurrent requests for the final credit cannot both reserve it", async () => {
    const { svc } = setup();
    await svc.updateSettings({ ...(await svc.ensureSettings(SHOP)), paidPlanActive: true });
    await svc.grantPeriodCredits(SHOP, "p1", 1, new Date("2026-12-01T00:00:00Z"));
    const results = await Promise.allSettled([
      svc.createPreview(input({ visitorId: "tab-1" })),
      svc.createPreview(input({ visitorId: "tab-2" })),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as TryoraError).code).toBe("CREDITS_EXHAUSTED");
  });

  it("duplicate creation with the same idempotency key returns the same job and reserves once", async () => {
    const { svc } = setup();
    await svc.grantTrial(SHOP);
    const i = input();
    const first = await svc.createPreview(i);
    const second = await svc.createPreview(i);
    expect(second.deduplicated).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    expect((await svc.balance(SHOP)).reserved).toBe(1);
  });

  it("repeated acknowledgements and late provider callbacks settle the job only once", async () => {
    const { svc } = setup();
    await svc.grantTrial(SHOP);
    const { job } = await svc.createPreview(input());
    await svc.transition(job.id, "GENERATING");
    await svc.transition(job.id, "CHECKING_RESULT");
    const ready = await svc.markReadyToDeliver(job.id);
    const token = ready.job.deliveryToken!;
    await svc.acknowledgeDelivery(job.id, token);
    await svc.acknowledgeDelivery(job.id, token); // browser retry
    const late = await svc.transition(job.id, "FAILED"); // stale callback
    expect(late.ignored).toBe(true);
    const bal = await svc.balance(SHOP);
    expect(bal.consumed).toBe(1);
    expect((await svc.getJob(job.id))!.state).toBe("DELIVERED");
  });

  it("rejects acknowledgement with a wrong or expired token", async () => {
    const { svc, clock } = setup();
    await svc.grantTrial(SHOP);
    const { job } = await svc.createPreview(input());
    await svc.transition(job.id, "GENERATING");
    await svc.transition(job.id, "CHECKING_RESULT");
    const ready = await svc.markReadyToDeliver(job.id);
    await expectCode(svc.acknowledgeDelivery(job.id, "forged"), "BAD_TOKEN");
    clock.advanceHours(1);
    await expectCode(svc.acknowledgeDelivery(job.id, ready.job.deliveryToken!), "BAD_TOKEN");
    expect((await svc.balance(SHOP)).consumed).toBe(0);
  });

  it("abandoned jobs expire and release their reservation", async () => {
    const { svc, clock } = setup();
    await svc.grantTrial(SHOP);
    const { job } = await svc.createPreview(input());
    await svc.transition(job.id, "GENERATING");
    clock.advanceHours(1);
    expect(await svc.expireStale(15 * 60_000)).toBe(1);
    expect((await svc.getJob(job.id))!.state).toBe("EXPIRED");
    const bal = await svc.balance(SHOP);
    expect(bal.reserved).toBe(0);
    expect(bal.consumed).toBe(0);
  });

  it("a confirmed bad result is refunded once, never twice", async () => {
    const { svc } = setup();
    await svc.grantTrial(SHOP);
    const delivered = await deliver(svc, input());
    expect((await svc.balance(SHOP)).availableTotal).toBe(TRIAL_CREDITS - 1);
    await svc.refundConfirmedIssue(delivered.id, "WRONG_COLOUR");
    expect((await svc.balance(SHOP)).availableTotal).toBe(TRIAL_CREDITS);
    await expectCode(svc.refundConfirmedIssue(delivered.id, "WRONG_COLOUR"), "ALREADY_REFUNDED");
    expect((await svc.balance(SHOP)).availableTotal).toBe(TRIAL_CREDITS);
  });

  it("monthly period credits are used before paid top-ups", async () => {
    const { svc } = setup();
    await svc.updateSettings({ ...(await svc.ensureSettings(SHOP)), paidPlanActive: true });
    await svc.grantTopUp(SHOP, "charge-1", 100);
    await svc.grantPeriodCredits(SHOP, "p1", 2, new Date("2026-12-01T00:00:00Z"));
    await deliver(svc, input());
    const b = await svc.balance(SHOP);
    expect(b.available.period).toBe(1);
    expect(b.available.topup).toBe(100);
  });

  it("billing webhook replays cannot duplicate period grants or top-ups", async () => {
    const { svc } = setup();
    await svc.updateSettings({ ...(await svc.ensureSettings(SHOP)), paidPlanActive: true });
    const end = new Date("2026-12-01T00:00:00Z");
    await svc.grantPeriodCredits(SHOP, "p1", 100, end);
    await svc.grantPeriodCredits(SHOP, "p1", 100, end);
    await svc.grantTopUp(SHOP, "charge-1", 100);
    await svc.grantTopUp(SHOP, "charge-1", 100);
    const b = await svc.balance(SHOP);
    expect(b.available.period).toBe(100);
    expect(b.available.topup).toBe(100);
  });

  it("top-ups are refused for stores without a paid plan", async () => {
    const { svc } = setup();
    await svc.grantTrial(SHOP);
    await expectCode(svc.grantTopUp(SHOP, "charge-1", 100), "PLAN_INACTIVE");
  });

  it("expired period credits cannot be reserved", async () => {
    const { svc, clock } = setup();
    await svc.updateSettings({ ...(await svc.ensureSettings(SHOP)), paidPlanActive: true });
    await svc.grantPeriodCredits(SHOP, "p1", 5, new Date("2026-11-02T00:00:00Z"));
    clock.advanceHours(48);
    await expectCode(svc.createPreview(input()), "CREDITS_EXHAUSTED");
  });
});

describe("trial", () => {
  it("ends after ten delivered previews, without converting to a paid plan", async () => {
    const { svc } = setup();
    await limitsOff(svc);
    await svc.grantTrial(SHOP);
    for (let i = 0; i < TRIAL_CREDITS; i++) await deliver(svc, input({ optionValue: `opt-${i}` }));
    const status = await svc.trialStatus(SHOP);
    expect(status.active).toBe(false);
    expect(status.delivered).toBe(TRIAL_CREDITS);
    await expectCode(svc.createPreview(input()), "PLAN_INACTIVE");
    expect((await svc.ensureSettings(SHOP)).paidPlanActive).toBe(false);
  });

  it("ends after fourteen days even with credits left", async () => {
    const { svc, clock } = setup();
    await svc.grantTrial(SHOP);
    await deliver(svc, input());
    clock.advanceHours(14 * 24 + 1);
    expect((await svc.trialStatus(SHOP)).active).toBe(false);
    await expectCode(svc.createPreview(input()), "PLAN_INACTIVE");
  });

  it("cannot be restarted (e.g. after reinstalling)", async () => {
    const { svc } = setup();
    const a = await svc.grantTrial(SHOP);
    const b = await svc.grantTrial(SHOP);
    expect(b.id).toBe(a.id);
    expect((await svc.balance(SHOP)).availableTotal).toBe(TRIAL_CREDITS);
  });
});

describe("shopper limits", () => {
  async function withLimits(perProduct?: number, storeWide?: number) {
    const s = setup();
    await s.svc.grantTrial(SHOP);
    await s.svc.updateSettings({
      ...(await s.svc.ensureSettings(SHOP)),
      quota: { enabled: true, perProduct, storeWide, window: { type: "rolling", hours: 24 } },
    });
    return s;
  }

  it("defaults to 10 previews per shopper per day, which the merchant can change", async () => {
    const { svc } = setup();
    await svc.grantPeriodCredits(SHOP, "p1", 100, new Date(Date.now() + 30 * 86_400_000));
    for (let i = 0; i < 10; i++) await deliver(svc, input({ optionValue: `opt-${i}` }));
    await expectCode(svc.createPreview(input()), "QUOTA_STORE");
    await deliver(svc, input({ visitorId: "another-shopper" }));
  });

  it("limits off means no shopper quota, only the merchant's credits apply", async () => {
    const { svc } = setup();
    await limitsOff(svc);
    await svc.grantTrial(SHOP);
    for (let i = 0; i < TRIAL_CREDITS; i++) await deliver(svc, input({ optionValue: `opt-${i}` }));
    await expectCode(svc.createPreview(input()), "PLAN_INACTIVE");
  });

  it("three per product: bed and sofa have separate allowances, and changing colour does not reset them", async () => {
    const { svc } = await withLimits(3);
    for (const c of ["Oat", "Olive", "Rust"]) await deliver(svc, input({ productId: "sofa", optionValue: c }));
    await expectCode(svc.createPreview(input({ productId: "sofa", optionValue: "Oat" })), "QUOTA_PRODUCT");
    await deliver(svc, input({ productId: "bed", optionValue: "Cream" }));
  });

  it("store-wide and per-product limits must both be satisfied", async () => {
    const { svc } = await withLimits(3, 2);
    await deliver(svc, input({ productId: "sofa" }));
    await deliver(svc, input({ productId: "bed" }));
    await expectCode(svc.createPreview(input({ productId: "chair" })), "QUOTA_STORE");
  });

  it("a live reservation occupies the allowance, so two tabs cannot use the final preview", async () => {
    const { svc } = await withLimits(1);
    await svc.createPreview(input({ productId: "sofa" })); // tab 1, still generating
    await expectCode(svc.createPreview(input({ productId: "sofa" })), "QUOTA_PRODUCT"); // tab 2
  });

  it("failed previews do not use the shopper's allowance", async () => {
    const { svc } = await withLimits(1);
    const { job } = await svc.createPreview(input({ productId: "sofa" }));
    await svc.transition(job.id, "FAILED");
    await deliver(svc, input({ productId: "sofa" }));
  });

  it("the rolling window frees the allowance after 24 hours", async () => {
    const { svc, clock } = await withLimits(1);
    await deliver(svc, input({ productId: "sofa" }));
    await expectCode(svc.createPreview(input({ productId: "sofa" })), "QUOTA_PRODUCT");
    clock.advanceHours(25);
    await deliver(svc, input({ productId: "sofa" }));
  });

  it("signed-in reconciliation counts a guest job once, not twice", async () => {
    const { svc } = await withLimits(2);
    // Guest preview, then the same person signs in on the same browser.
    await deliver(svc, input({ productId: "sofa", visitorId: "v1" }));
    await deliver(svc, input({ productId: "sofa", visitorId: "v1", verifiedCustomerId: "cust-9" }));
    await expectCode(
      svc.createPreview(input({ productId: "sofa", visitorId: "v1", verifiedCustomerId: "cust-9" })),
      "QUOTA_PRODUCT",
    );
    // On another device, the verified customer id carries the usage across.
    await expectCode(
      svc.createPreview(input({ productId: "sofa", visitorId: "phone", verifiedCustomerId: "cust-9" })),
      "QUOTA_PRODUCT",
    );
  });

  it("a confirmed bad result also restores the shopper's allowance", async () => {
    const { svc } = await withLimits(1);
    const d = await deliver(svc, input({ productId: "sofa" }));
    await svc.refundConfirmedIssue(d.id, "ROOM_CHANGED");
    await deliver(svc, input({ productId: "sofa" }));
  });
});

describe("lead capture", () => {
  it("required by default: generation is refused until the email step is done", async () => {
    const { svc } = setup();
    await svc.grantTrial(SHOP);
    await expectCode(svc.createPreview(input({ leadStepDone: false })), "LEAD_REQUIRED");
    await svc.createPreview(input({ leadStepDone: true }));
  });

  it("merchants can switch lead capture off", async () => {
    const { svc } = setup();
    await svc.grantTrial(SHOP);
    await svc.updateSettings({ ...(await svc.ensureSettings(SHOP)), leadCapture: "off" });
    await svc.createPreview(input({ leadStepDone: false }));
  });
});
