import { randomBytes, randomUUID } from "node:crypto";
import { TryoraError } from "./errors.js";
import { canTransition, isTerminal, RESERVATION_HELD } from "./jobs.js";
import { pickGrantForReservation, shopBalance, trialDeliveredCount, type ShopBalance } from "./ledger.js";
import { checkQuota } from "./quota.js";
import type { Store, Tx } from "./store.js";
import type { JobId, JobState, LedgerEntry, PreviewJob, ShopId, ShopSettings } from "./types.js";

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

export const TRIAL_CREDITS = 10;
export const TRIAL_DAYS = 14;
/** How long a shopper's browser has to acknowledge a ready result before the reservation can expire. */
export const DELIVERY_TOKEN_TTL_MS = 5 * 60_000;

export interface CreatePreviewInput {
  shopId: ShopId;
  idempotencyKey: string;
  visitorId: string;
  verifiedCustomerId?: string;
  productId: string;
  optionValue: string;
  referenceVersion: string;
  roomPhotoHash: string;
  /** True once the shopper completed (or, if allowed, skipped) the email step this session. */
  leadStepDone: boolean;
}

export interface CreatePreviewResult {
  job: PreviewJob;
  /** True when this call returned an existing job for the same idempotency key (no new charge). */
  deduplicated: boolean;
}

export interface TransitionResult {
  job: PreviewJob;
  /** True when the job was already finished and the update was ignored (e.g. a late provider callback). */
  ignored: boolean;
}

export const DEFAULT_SETTINGS = (shopId: ShopId): ShopSettings => ({
  shopId,
  quota: { enabled: false, window: { type: "rolling", hours: 24 } },
  leadCapture: "required",
  paidPlanActive: false,
});

/**
 * Orchestrates preview jobs and credit accounting. Every method runs in one transaction.
 * Rules (brief sections 7 and 8):
 *  - a credit and any enabled shopper allowance are reserved atomically before generation;
 *  - the reservation is consumed exactly once, only when a valid result is acknowledged as delivered;
 *  - rejected input, failed or rejected output, cancellation and expiry release the reservation;
 *  - a confirmed unusable result restores its credit and allowance once.
 */
export class PreviewService {
  constructor(
    private readonly store: Store,
    private readonly clock: Clock = systemClock,
  ) {}

  // ---------- Credits and entitlements ----------

  async ensureSettings(shopId: ShopId): Promise<ShopSettings> {
    return this.store.transaction((tx) => this.settingsIn(tx, shopId));
  }

  async updateSettings(settings: ShopSettings): Promise<void> {
    await this.store.transaction((tx) => tx.putSettings(settings));
  }

  /** Grants the one-off free trial. Calling again for the same shop has no effect (no trial restart). */
  async grantTrial(shopId: ShopId): Promise<LedgerEntry> {
    return this.store.transaction((tx) => {
      const now = this.clock.now();
      return this.grantOnce(tx, {
        shopId,
        reference: "grant:trial",
        bucket: "trial",
        quantity: TRIAL_CREDITS,
        expiresAt: new Date(now.getTime() + TRIAL_DAYS * 86_400_000),
      });
    });
  }

  /** Monthly plan allowance. Idempotent per billing period, so a replayed billing webhook grants nothing extra. */
  async grantPeriodCredits(shopId: ShopId, periodId: string, quantity: number, periodEndsAt: Date) {
    return this.store.transaction((tx) =>
      this.grantOnce(tx, {
        shopId,
        reference: `grant:period:${periodId}`,
        bucket: "period",
        quantity,
        expiresAt: periodEndsAt,
      }),
    );
  }

  /** Paid top-up. Rolls over while subscribed. Idempotent per Shopify charge id. Paid plans only. */
  async grantTopUp(shopId: ShopId, chargeId: string, quantity: number) {
    return this.store.transaction((tx) => {
      const settings = this.settingsIn(tx, shopId);
      if (!settings.paidPlanActive) throw new TryoraError("PLAN_INACTIVE", "Top-ups are for paid plans");
      return this.grantOnce(tx, { shopId, reference: `grant:topup:${chargeId}`, bucket: "topup", quantity });
    });
  }

  async balance(shopId: ShopId): Promise<ShopBalance> {
    return this.store.transaction((tx) => shopBalance(tx.ledger(shopId), this.clock.now()));
  }

  async trialStatus(shopId: ShopId) {
    return this.store.transaction((tx) => {
      const entries = tx.ledger(shopId);
      const grant = entries.find((e) => e.reference === "grant:trial");
      if (!grant) return { started: false, active: false, delivered: 0 } as const;
      const delivered = trialDeliveredCount(entries);
      const expired = !!grant.expiresAt && grant.expiresAt.getTime() <= this.clock.now().getTime();
      return {
        started: true,
        active: !expired && delivered < TRIAL_CREDITS,
        delivered,
        endsAt: grant.expiresAt,
      } as const;
    });
  }

  // ---------- Jobs ----------

  async createPreview(input: CreatePreviewInput): Promise<CreatePreviewResult> {
    return this.store.transaction((tx) => {
      const existing = tx.findJobByIdempotencyKey(input.shopId, input.idempotencyKey);
      if (existing) return { job: existing, deduplicated: true };

      const now = this.clock.now();
      const settings = this.settingsIn(tx, input.shopId);

      if (settings.leadCapture !== "off" && !input.leadStepDone) {
        throw new TryoraError("LEAD_REQUIRED");
      }

      const quota = checkQuota(
        tx.quotaUsages(input.shopId),
        { visitorId: input.visitorId, verifiedCustomerId: input.verifiedCustomerId },
        settings.quota,
        input.productId,
        now,
      );
      if (!quota.ok) throw new TryoraError(quota.scope === "product" ? "QUOTA_PRODUCT" : "QUOTA_STORE");

      const entries = tx.ledger(input.shopId);
      const grant = pickGrantForReservation(entries, now);
      if (!grant) {
        const hasTrial = entries.some((e) => e.reference === "grant:trial");
        throw new TryoraError(hasTrial && !settings.paidPlanActive ? "PLAN_INACTIVE" : "CREDITS_EXHAUSTED");
      }

      const job: PreviewJob = {
        id: randomUUID(),
        shopId: input.shopId,
        idempotencyKey: input.idempotencyKey,
        visitorId: input.visitorId,
        verifiedCustomerId: input.verifiedCustomerId,
        productId: input.productId,
        optionValue: input.optionValue,
        referenceVersion: input.referenceVersion,
        roomPhotoHash: input.roomPhotoHash,
        state: "RESERVED",
        attempts: 0,
        costMicros: 0,
        createdAt: now,
        updatedAt: now,
      };
      tx.insertJob(job);
      tx.appendLedger({
        id: randomUUID(),
        shopId: input.shopId,
        type: "RESERVE",
        quantity: 1,
        reference: `reserve:${job.id}`,
        grantId: grant.id,
        bucket: grant.bucket,
        jobId: job.id,
        createdAt: now,
      });
      tx.putQuotaUsage({
        jobId: job.id,
        shopId: input.shopId,
        visitorId: input.visitorId,
        verifiedCustomerId: input.verifiedCustomerId,
        productId: input.productId,
        state: "RESERVED",
        reservedAt: now,
      });
      return { job, deduplicated: false };
    });
  }

  /**
   * Moves a job forward. Late or repeated updates to a finished job are ignored, never applied,
   * so a stale provider callback cannot restart work or charge twice.
   */
  async transition(
    jobId: JobId,
    to: JobState,
    patch: Partial<Pick<PreviewJob, "reasonCode" | "providerRequestId" | "attempts" | "costMicros">> = {},
  ): Promise<TransitionResult> {
    if (to === "DELIVERED") throw new TryoraError("INVALID_TRANSITION", "Use acknowledgeDelivery");
    if (to === "READY_TO_DELIVER") throw new TryoraError("INVALID_TRANSITION", "Use markReadyToDeliver");
    return this.store.transaction((tx) => this.transitionIn(tx, jobId, to, patch));
  }

  /** The result passed checks and is held in transient memory. Issues a short-lived delivery token. */
  async markReadyToDeliver(jobId: JobId, costMicros?: number): Promise<TransitionResult> {
    return this.store.transaction((tx) => {
      const r = this.transitionIn(tx, jobId, "READY_TO_DELIVER", costMicros !== undefined ? { costMicros } : {});
      if (r.ignored) return r;
      const job = { ...r.job };
      job.deliveryToken = randomBytes(24).toString("base64url");
      job.deliveryTokenExpiresAt = new Date(this.clock.now().getTime() + DELIVERY_TOKEN_TTL_MS);
      tx.updateJob(job);
      return { job, ignored: false };
    });
  }

  /**
   * Called when the shopper's browser confirms it received the image. Settles the reservation exactly once.
   * Retrying with the same token after success is safe and returns the delivered job.
   */
  async acknowledgeDelivery(jobId: JobId, token: string): Promise<PreviewJob> {
    return this.store.transaction((tx) => {
      const job = tx.getJob(jobId);
      if (!job) throw new TryoraError("NOT_FOUND");
      if (!job.deliveryToken || job.deliveryToken !== token) throw new TryoraError("BAD_TOKEN");
      if (job.state === "DELIVERED") return job;
      if (job.state !== "READY_TO_DELIVER") throw new TryoraError("INVALID_TRANSITION", `Job is ${job.state}`);
      const now = this.clock.now();
      if (job.deliveryTokenExpiresAt && job.deliveryTokenExpiresAt.getTime() < now.getTime()) {
        throw new TryoraError("BAD_TOKEN", "Delivery token expired");
      }
      const reserve = tx.findLedgerByReference(job.shopId, `reserve:${job.id}`);
      tx.appendLedger({
        id: randomUUID(),
        shopId: job.shopId,
        type: "CONSUME",
        quantity: 1,
        reference: `consume:${job.id}`,
        grantId: reserve?.grantId,
        bucket: reserve?.bucket,
        jobId: job.id,
        createdAt: now,
      });
      const usage = tx.quotaUsages(job.shopId).find((u) => u.jobId === job.id);
      if (usage) tx.putQuotaUsage({ ...usage, state: "DELIVERED", deliveredAt: now });
      const delivered: PreviewJob = { ...job, state: "DELIVERED", deliveredAt: now, updatedAt: now };
      tx.updateJob(delivered);
      return delivered;
    });
  }

  /**
   * A reported problem was confirmed (e.g. wrong product, room changed). Restores the original credit and
   * the shopper's allowance once. Reporting alone, or a change of mind, does not refund.
   */
  async refundConfirmedIssue(jobId: JobId, issueCategory: string): Promise<PreviewJob> {
    return this.store.transaction((tx) => {
      const job = tx.getJob(jobId);
      if (!job) throw new TryoraError("NOT_FOUND");
      if (job.state !== "DELIVERED") throw new TryoraError("NOT_DELIVERED");
      if (job.refundedAt) throw new TryoraError("ALREADY_REFUNDED");
      const now = this.clock.now();
      // Restored as a non-expiring "refund" credit, so it is usable even if the original period has ended.
      tx.appendLedger({
        id: randomUUID(),
        shopId: job.shopId,
        type: "GRANT",
        quantity: 1,
        reference: `refund:${job.id}`,
        bucket: "refund",
        jobId: job.id,
        createdAt: now,
      });
      const usage = tx.quotaUsages(job.shopId).find((u) => u.jobId === job.id);
      if (usage) tx.putQuotaUsage({ ...usage, state: "RELEASED" });
      const refunded: PreviewJob = { ...job, refundedAt: now, reasonCode: `REFUNDED:${issueCategory}`, updatedAt: now };
      tx.updateJob(refunded);
      return refunded;
    });
  }

  /** Expires jobs whose reservation has been held too long without delivery, releasing their credit. */
  async expireStale(maxHeldMs: number): Promise<number> {
    return this.store.transaction((tx) => {
      const now = this.clock.now().getTime();
      let count = 0;
      for (const job of tx.listJobs()) {
        if (!RESERVATION_HELD.has(job.state)) continue;
        const tokenExpired =
          job.state === "READY_TO_DELIVER" && job.deliveryTokenExpiresAt && job.deliveryTokenExpiresAt.getTime() < now;
        if (tokenExpired || now - job.updatedAt.getTime() > maxHeldMs) {
          this.transitionIn(tx, job.id, "EXPIRED", { reasonCode: "NOT_DELIVERED_IN_TIME" });
          count++;
        }
      }
      return count;
    });
  }

  async getJob(jobId: JobId): Promise<PreviewJob | undefined> {
    return this.store.transaction((tx) => tx.getJob(jobId));
  }

  // ---------- internals ----------

  private settingsIn(tx: Tx, shopId: ShopId): ShopSettings {
    const s = tx.getSettings(shopId);
    if (s) return s;
    const created = DEFAULT_SETTINGS(shopId);
    tx.putSettings(created);
    return created;
  }

  private grantOnce(
    tx: Tx,
    g: { shopId: ShopId; reference: string; bucket: LedgerEntry["bucket"]; quantity: number; expiresAt?: Date },
  ): LedgerEntry {
    const existing = tx.findLedgerByReference(g.shopId, g.reference);
    if (existing) return existing;
    const entry: LedgerEntry = {
      id: randomUUID(),
      shopId: g.shopId,
      type: "GRANT",
      quantity: g.quantity,
      reference: g.reference,
      bucket: g.bucket,
      expiresAt: g.expiresAt,
      createdAt: this.clock.now(),
    };
    tx.appendLedger(entry);
    return entry;
  }

  private transitionIn(
    tx: Tx,
    jobId: JobId,
    to: JobState,
    patch: Partial<Pick<PreviewJob, "reasonCode" | "providerRequestId" | "attempts" | "costMicros">>,
  ): TransitionResult {
    const job = tx.getJob(jobId);
    if (!job) throw new TryoraError("NOT_FOUND");
    if (isTerminal(job.state)) return { job, ignored: true };
    if (!canTransition(job.state, to)) {
      throw new TryoraError("INVALID_TRANSITION", `${job.state} -> ${to}`);
    }
    const now = this.clock.now();
    const updated: PreviewJob = { ...job, ...patch, state: to, updatedAt: now };
    tx.updateJob(updated);

    const releasing = isTerminal(to) && to !== "DELIVERED" && RESERVATION_HELD.has(job.state);
    if (releasing) {
      const reserve = tx.findLedgerByReference(job.shopId, `reserve:${job.id}`);
      if (reserve) {
        tx.appendLedger({
          id: randomUUID(),
          shopId: job.shopId,
          type: "RELEASE",
          quantity: 1,
          reference: `release:${job.id}`,
          grantId: reserve.grantId,
          bucket: reserve.bucket,
          jobId: job.id,
          createdAt: now,
        });
      }
      const usage = tx.quotaUsages(job.shopId).find((u) => u.jobId === job.id);
      if (usage) tx.putQuotaUsage({ ...usage, state: "RELEASED" });
    }
    return { job: updated, ignored: false };
  }
}
