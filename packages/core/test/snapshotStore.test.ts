import { describe, expect, it } from "vitest";
import { PreviewService, SnapshotStore, type ShopChanges, type ShopSnapshot, type SnapshotBackend } from "../src/index.js";

/** Fake database: keeps rows per shop and serialises access per shop, like the Postgres advisory lock. */
function fakeBackend() {
  const db = new Map<string, ShopSnapshot>();
  const locks = new Map<string, Promise<unknown>>();
  const saves: ShopChanges[] = [];
  const backend: SnapshotBackend = {
    async shopIdForJob(jobId) {
      for (const [shop, s] of db) if (s.jobs.some((j) => j.id === jobId)) return shop;
      return undefined;
    },
    async shopsWithHeldJobs() {
      return [...db.keys()];
    },
    withShop(shopId, fn) {
      const run = async () => {
        const row = db.get(shopId) ?? { ledger: [], jobs: [], quota: [] };
        return fn({
          load: async () => structuredClone(row),
          save: async (c) => {
            saves.push(c);
            const next = structuredClone(row);
            if (c.settings) next.settings = c.settings;
            next.ledger.push(...c.newLedger);
            next.jobs.push(...c.newJobs);
            for (const j of c.updatedJobs) next.jobs[next.jobs.findIndex((x) => x.id === j.id)] = j;
            for (const q of c.quota) {
              const i = next.quota.findIndex((x) => x.jobId === q.jobId);
              if (i >= 0) next.quota[i] = q;
              else next.quota.push(q);
            }
            db.set(shopId, next);
          },
        });
      };
      const prev = locks.get(shopId) ?? Promise.resolve();
      const p = prev.then(run, run);
      locks.set(shopId, p.catch(() => undefined));
      return p;
    },
  };
  return { backend, db, saves };
}

describe("database-backed store", () => {
  it("runs the full credit lifecycle and writes only what changed", async () => {
    const { backend, db } = fakeBackend();
    const svc = new PreviewService(new SnapshotStore(backend));
    await svc.grantTrial("shop-a");
    expect((await svc.balance("shop-a")).availableTotal).toBe(10);

    const { job } = await svc.createPreview({
      shopId: "shop-a", idempotencyKey: "k1", visitorId: "v1", productId: "p1",
      optionValue: "Oat", referenceVersion: "r1", roomPhotoHash: "h1", leadStepDone: true,
    });
    for (const s of ["QUEUED", "GENERATING", "CHECKING_RESULT"] as const) await svc.transition(job.id, s);
    const ready = await svc.markReadyToDeliver(job.id);
    await svc.acknowledgeDelivery(job.id, ready.job.deliveryToken!);

    expect((await svc.balance("shop-a")).availableTotal).toBe(9);
    expect(db.get("shop-a")!.ledger.map((e) => e.type)).toEqual(["GRANT", "RESERVE", "CONSUME"]);
  });

  it("concurrent previews for one shop cannot overspend credits", async () => {
    const { backend } = fakeBackend();
    const svc = new PreviewService(new SnapshotStore(backend));
    await svc.grantTrial("shop-b");
    const attempts = Array.from({ length: 15 }, (_, i) =>
      svc.createPreview({
        shopId: "shop-b", idempotencyKey: `k${i}`, visitorId: `v${i}`, productId: "p1",
        optionValue: "Oat", referenceVersion: "r1", roomPhotoHash: `h${i}`, leadStepDone: true,
      }).then(() => "ok", () => "refused"),
    );
    const results = await Promise.all(attempts);
    expect(results.filter((r) => r === "ok")).toHaveLength(10);
  });
});
