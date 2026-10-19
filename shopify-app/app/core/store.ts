// GENERATED from packages/core/src by scripts/sync-core.mjs. Do not edit here.
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

/** Every transaction works on one shop: named directly, or found from a job id. */
export type TxScope = { shopId: ShopId } | { jobId: JobId };

export interface Store {
  transaction<T>(scope: TxScope, fn: (tx: Tx) => T | Promise<T>): Promise<T>;
  /** Shops that currently hold at least one reserved credit (for the expiry sweep). */
  shopsWithHeldJobs(): Promise<ShopId[]>;
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

  async shopsWithHeldJobs(): Promise<ShopId[]> {
    return [...new Set([...this.data.jobs.values()].map((j) => j.shopId))];
  }

  transaction<T>(_scope: TxScope, fn: (tx: Tx) => T | Promise<T>): Promise<T> {
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

// ---------------------------------------------------------------------------------------------
// Database-backed store
// ---------------------------------------------------------------------------------------------

/** Everything the engine needs for one shop, loaded at the start of a transaction. */
export interface ShopSnapshot {
  settings?: ShopSettings;
  ledger: LedgerEntry[];
  jobs: PreviewJob[];
  quota: QuotaUsage[];
}

/** What a transaction changed. Ledger entries are append-only; jobs and quota rows are upserted. */
export interface ShopChanges {
  settings?: ShopSettings;
  newLedger: LedgerEntry[];
  newJobs: PreviewJob[];
  updatedJobs: PreviewJob[];
  quota: QuotaUsage[];
}

/**
 * A database plugs in here (the Shopify app supplies a Prisma version). `withShop` must run `fn` inside one
 * database transaction that holds an exclusive per-shop lock, so two requests for the same shop can't
 * interleave. Unique constraints in the database are a second line of defence.
 */
export interface SnapshotBackend {
  shopIdForJob(jobId: JobId): Promise<ShopId | undefined>;
  shopsWithHeldJobs(): Promise<ShopId[]>;
  withShop<T>(shopId: ShopId, fn: (io: { load(): Promise<ShopSnapshot>; save(c: ShopChanges): Promise<void> }) => Promise<T>): Promise<T>;
}

/**
 * Runs the engine's synchronous transaction logic against a per-shop snapshot, then writes only the changes.
 * Same rules as InMemoryStore: duplicate references and idempotency keys are rejected.
 */
export class SnapshotStore implements Store {
  constructor(private readonly backend: SnapshotBackend) {}

  shopsWithHeldJobs(): Promise<ShopId[]> {
    return this.backend.shopsWithHeldJobs();
  }

  async transaction<T>(scope: TxScope, fn: (tx: Tx) => T | Promise<T>): Promise<T> {
    const shopId = "shopId" in scope ? scope.shopId : await this.backend.shopIdForJob(scope.jobId);
    if (!shopId) {
      // Unknown job: run against an empty snapshot so callers get their normal NOT_FOUND handling.
      return fn(snapshotTx({ ledger: [], jobs: [], quota: [] }, newChanges()));
    }
    return this.backend.withShop(shopId, async (io) => {
      const snap = await io.load();
      const changes = newChanges();
      const result = await fn(snapshotTx(snap, changes));
      await io.save(changes);
      return result;
    });
  }
}

function newChanges(): ShopChanges {
  return { newLedger: [], newJobs: [], updatedJobs: [], quota: [] };
}

function snapshotTx(snap: ShopSnapshot, changes: ShopChanges): Tx {
  const ledger = snap.ledger.map((e) => structuredClone(e));
  const jobs = new Map(snap.jobs.map((j) => [j.id, structuredClone(j)]));
  const quota = new Map(snap.quota.map((u) => [u.jobId, structuredClone(u)]));
  let settings = snap.settings ? structuredClone(snap.settings) : undefined;
  const upsertChange = <K extends { id?: string; jobId?: string }>(list: K[], item: K, key: (x: K) => string) => {
    const i = list.findIndex((x) => key(x) === key(item));
    if (i >= 0) list[i] = item;
    else list.push(item);
  };
  return {
    getSettings: () => structuredClone(settings),
    putSettings: (s) => {
      settings = structuredClone(s);
      changes.settings = structuredClone(s);
    },
    ledger: () => ledger.map((e) => structuredClone(e)),
    appendLedger: (entry) => {
      if (ledger.some((e) => e.reference === entry.reference)) {
        throw new DuplicateReferenceError(`ledger reference ${entry.reference}`);
      }
      ledger.push(structuredClone(entry));
      changes.newLedger.push(structuredClone(entry));
    },
    findLedgerByReference: (_shopId, reference) => structuredClone(ledger.find((e) => e.reference === reference)),
    getJob: (id) => structuredClone(jobs.get(id)),
    findJobByIdempotencyKey: (_shopId, key) => structuredClone([...jobs.values()].find((j) => j.idempotencyKey === key)),
    insertJob: (job) => {
      if ([...jobs.values()].some((j) => j.idempotencyKey === job.idempotencyKey)) {
        throw new DuplicateReferenceError(`idempotency key ${job.idempotencyKey}`);
      }
      jobs.set(job.id, structuredClone(job));
      changes.newJobs.push(structuredClone(job));
    },
    updateJob: (job) => {
      jobs.set(job.id, structuredClone(job));
      const fresh = changes.newJobs.findIndex((j) => j.id === job.id);
      if (fresh >= 0) changes.newJobs[fresh] = structuredClone(job);
      else upsertChange(changes.updatedJobs, structuredClone(job), (j) => j.id);
    },
    listJobs: () => [...jobs.values()].map((j) => structuredClone(j)),
    quotaUsages: () => [...quota.values()].map((u) => structuredClone(u)),
    putQuotaUsage: (u) => {
      quota.set(u.jobId, structuredClone(u));
      upsertChange(changes.quota, structuredClone(u), (x) => x.jobId);
    },
  };
}
