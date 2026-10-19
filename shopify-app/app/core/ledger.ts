// GENERATED from packages/core/src by scripts/sync-core.mjs. Do not edit here.
import type { CreditBucket, LedgerEntry } from "./types.js";

/**
 * Credits are never stored as a mutable number. Balances are derived from the append-only ledger,
 * so every credit can be traced to a grant, a reservation and a settlement.
 */

export interface GrantBalance {
  grant: LedgerEntry;
  /** Credits still free to reserve (ignores expiry). */
  remaining: number;
  /** Credits held by running jobs. */
  reserved: number;
  consumed: number;
}

export interface ShopBalance {
  /** Free credits that can be reserved now, by bucket. */
  available: Record<CreditBucket, number>;
  availableTotal: number;
  reserved: number;
  consumed: number;
}

/** Order in which buckets are drawn down: expiring credits first, paid top-ups last. */
export const BUCKET_ORDER: CreditBucket[] = ["trial", "period", "refund", "topup"];

export function grantBalances(entries: LedgerEntry[]): GrantBalance[] {
  const grants = entries.filter((e) => e.type === "GRANT");
  const byGrant = new Map<string, GrantBalance>();
  for (const g of grants) byGrant.set(g.id, { grant: g, remaining: g.quantity, reserved: 0, consumed: 0 });

  // A reservation is active until a CONSUME or RELEASE exists for the same job.
  const settledJobs = new Set(
    entries.filter((e) => e.type === "CONSUME" || e.type === "RELEASE").map((e) => e.jobId),
  );
  const consumedJobs = new Set(entries.filter((e) => e.type === "CONSUME").map((e) => e.jobId));

  for (const e of entries) {
    if (e.type !== "RESERVE" || !e.grantId) continue;
    const b = byGrant.get(e.grantId);
    if (!b) continue;
    if (!settledJobs.has(e.jobId)) {
      b.reserved += e.quantity;
      b.remaining -= e.quantity;
    } else if (consumedJobs.has(e.jobId)) {
      b.consumed += e.quantity;
      b.remaining -= e.quantity;
    }
    // Released reservations return the credit, so they change nothing.
  }
  return [...byGrant.values()];
}

export function isGrantUsable(grant: LedgerEntry, now: Date): boolean {
  return !grant.expiresAt || grant.expiresAt.getTime() > now.getTime();
}

export function shopBalance(entries: LedgerEntry[], now: Date): ShopBalance {
  const available: Record<CreditBucket, number> = { trial: 0, period: 0, refund: 0, topup: 0 };
  let reserved = 0;
  let consumed = 0;
  for (const b of grantBalances(entries)) {
    reserved += b.reserved;
    consumed += b.consumed;
    if (isGrantUsable(b.grant, now) && b.remaining > 0 && b.grant.bucket) {
      available[b.grant.bucket] += b.remaining;
    }
  }
  const availableTotal = Object.values(available).reduce((a, n) => a + n, 0);
  return { available, availableTotal, reserved, consumed };
}

/** Picks the grant the next reservation should draw on, or undefined if no credit is free. */
export function pickGrantForReservation(entries: LedgerEntry[], now: Date): LedgerEntry | undefined {
  const candidates = grantBalances(entries).filter(
    (b) => b.remaining > 0 && isGrantUsable(b.grant, now) && b.grant.bucket,
  );
  candidates.sort((a, b) => {
    const order = BUCKET_ORDER.indexOf(a.grant.bucket!) - BUCKET_ORDER.indexOf(b.grant.bucket!);
    if (order !== 0) return order;
    // Within a bucket: soonest expiry first, then oldest grant first.
    const ea = a.grant.expiresAt?.getTime() ?? Infinity;
    const eb = b.grant.expiresAt?.getTime() ?? Infinity;
    if (ea !== eb) return ea - eb;
    return a.grant.createdAt.getTime() - b.grant.createdAt.getTime();
  });
  return candidates[0]?.grant;
}

/** Delivered previews drawn from the trial bucket: the trial ends at 10 of these or 14 days. */
export function trialDeliveredCount(entries: LedgerEntry[]): number {
  const trialGrantIds = new Set(entries.filter((e) => e.type === "GRANT" && e.bucket === "trial").map((e) => e.id));
  const consumedJobs = new Set(entries.filter((e) => e.type === "CONSUME").map((e) => e.jobId));
  return entries.filter(
    (e) => e.type === "RESERVE" && e.grantId && trialGrantIds.has(e.grantId) && consumedJobs.has(e.jobId),
  ).length;
}
