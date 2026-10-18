import type { JobId, LedgerEntry, PreviewJob, QuotaUsage, ShopId, ShopSettings } from "./types.js";

/**
 * Persistence boundary. Production uses PostgreSQL via Prisma (see prisma/schema.prisma), where each
 * transaction runs at SERIALIZABLE isolation and unique constraints back the idempotency rules below.
 * Tests use InMemoryStore, which serialises transactions and enforces the same constraints.
 */
export interface Tx {
  getSettings(shopId: ShopId): ShopSettings | undefined;
  putSettings(settings: ShopSettings): void;

  ledger(shopId: ShopId): LedgerEntry[];
  /** Must throw DuplicateReferenceError if (shopId, reference) already exists. */
  appendLedger(entry: LedgerEntry): void;
  findLedgerByReference(shopId: ShopId, reference: string): LedgerEntry | undefined;

  getJob(id: JobId): PreviewJob | undefined;
  findJobByIdempotencyKey(shopId: ShopId, key: string): PreviewJob | undefined;
  /** Must throw DuplicateReferenceError if (shopId, idempotencyKey) already exists. */
  insertJob(job: PreviewJob): void;
  updateJob(job: PreviewJob): void;
  listJobs(shopId?: ShopId): PreviewJob[];

  quotaUsages(shopId: ShopId): QuotaUsage[];
  putQuotaUsage(usage: QuotaUsage): void;
}

export interface Store {
  transaction<T>(fn: (tx: Tx) => T | Promise<T>): Promise<T>;
}

export class DuplicateReferenceError extends Error {
  constructor(what: string) {
    super(`Duplicate ${what}`);
    this.name = "DuplicateReferenceError";
  }
}

interface Data {
  settings: Map<ShopId, ShopSettings>;
  ledger: LedgerEntry[];
  jobs: Map<JobId, PreviewJob>;
  quota: Map<JobId, QuotaUsage>;
}

function cloneData(d: Data): Data {
  return {
    settings: new Map([...d.settings].map(([k, v]) => [k, structuredClone(v)])),
    ledger: d.ledger.map((e) => structuredClone(e)),
    jobs: new Map([...d.jobs].map(([k, v]) => [k, structuredClone(v)])),
    quota: new Map([...d.quota].map(([k, v]) => [k, structuredClone(v)])),
  };
}

/** In-memory store for tests and local mock mode. Transactions are serialised and roll back on error. */
export class InMemoryStore implements Store {
  private data: Data = { settings: new Map(), ledger: [], jobs: new Map(), quota: new Map() };
  private queue: Promise<unknown> = Promise.resolve();

  transaction<T>(fn: (tx: Tx) => T | Promise<T>): Promise<T> {
    const run = async () => {
      const working = cloneData(this.data);
      const result = await fn(this.makeTx(working));
      this.data = working; // commit
      return result;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private makeTx(d: Data): Tx {
    return {
      getSettings: (shopId) => structuredClone(d.settings.get(shopId)),
      putSettings: (s) => void d.settings.set(s.shopId, structuredClone(s)),
      ledger: (shopId) => d.ledger.filter((e) => e.shopId === shopId).map((e) => structuredClone(e)),
      appendLedger: (entry) => {
        if (d.ledger.some((e) => e.shopId === entry.shopId && e.reference === entry.reference)) {
          throw new DuplicateReferenceError(`ledger reference ${entry.reference}`);
        }
        d.ledger.push(structuredClone(entry));
      },
      findLedgerByReference: (shopId, reference) =>
        structuredClone(d.ledger.find((e) => e.shopId === shopId && e.reference === reference)),
      getJob: (id) => structuredClone(d.jobs.get(id)),
      findJobByIdempotencyKey: (shopId, key) =>
        structuredClone([...d.jobs.values()].find((j) => j.shopId === shopId && j.idempotencyKey === key)),
      insertJob: (job) => {
        if ([...d.jobs.values()].some((j) => j.shopId === job.shopId && j.idempotencyKey === job.idempotencyKey)) {
          throw new DuplicateReferenceError(`idempotency key ${job.idempotencyKey}`);
        }
        d.jobs.set(job.id, structuredClone(job));
      },
      updateJob: (job) => void d.jobs.set(job.id, structuredClone(job)),
      listJobs: (shopId) =>
        [...d.jobs.values()].filter((j) => !shopId || j.shopId === shopId).map((j) => structuredClone(j)),
      quotaUsages: (shopId) => [...d.quota.values()].filter((u) => u.shopId === shopId).map((u) => structuredClone(u)),
      putQuotaUsage: (u) => void d.quota.set(u.jobId, structuredClone(u)),
    };
  }
}
