// GENERATED from packages/core/src by scripts/sync-core.mjs. Do not edit here.
import type { JobState } from "./types.js";

/** Allowed state changes for a preview job (brief section 16). Anything else is refused. */
const TRANSITIONS: Record<JobState, JobState[]> = {
  CREATED: ["VALIDATING", "REJECTED", "CANCELLED"],
  VALIDATING: ["RESERVED", "REJECTED", "CANCELLED"],
  RESERVED: ["QUEUED", "GENERATING", "FAILED", "CANCELLED", "EXPIRED"],
  QUEUED: ["GENERATING", "FAILED", "CANCELLED", "EXPIRED"],
  GENERATING: ["CHECKING_RESULT", "FAILED", "CANCELLED", "EXPIRED"],
  CHECKING_RESULT: ["READY_TO_DELIVER", "REJECTED", "FAILED", "CANCELLED", "EXPIRED"],
  READY_TO_DELIVER: ["DELIVERED", "CANCELLED", "EXPIRED"],
  DELIVERED: [],
  REJECTED: [],
  FAILED: [],
  CANCELLED: [],
  EXPIRED: [],
};

export const TERMINAL_STATES: ReadonlySet<JobState> = new Set([
  "DELIVERED",
  "REJECTED",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
]);

/** States in which a credit reservation exists and has not yet been settled. */
export const RESERVATION_HELD: ReadonlySet<JobState> = new Set([
  "RESERVED",
  "QUEUED",
  "GENERATING",
  "CHECKING_RESULT",
  "READY_TO_DELIVER",
]);

export function canTransition(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(state: JobState): boolean {
  return TERMINAL_STATES.has(state);
}

/** Maximum automatic generation retries per job; retries never create a second charge. */
export const MAX_AUTOMATIC_RETRIES = 1;
