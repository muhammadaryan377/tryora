/**
 * In-memory event buffers for streamed Room Assistant turns.
 *
 * A turn runs on the server and appends events (progress, model text deltas, verified cards, final answer). The
 * storefront reads them incrementally by long-polling through the Shopify app proxy, which works even when the
 * proxy buffers whole responses. Nothing here is persisted: buffers hold no photos and expire minutes after a turn.
 *
 * Every read and cancel is checked against the shop and visitor that started the turn. Turn IDs carry the worker
 * ID (same scheme as preview jobs), so with TRYORA_WORKER_ORIGINS configured, reads can be routed to the owner.
 */
import { randomUUID } from "node:crypto";
import { workerId } from "../preview-worker.server";
import { logAssistant } from "./log.server";

export interface TurnEvent { type: string; [key: string]: unknown }

export interface Turn {
  id: string;
  shopId: string;
  visitorId: string;
  events: TurnEvent[];
  bytes: number;
  done: boolean;
  controller: AbortController;
  waiters: Set<() => void>;
  createdAt: number;
  finishedAt?: number;
}

const MAX_TURNS = 1000;
const MAX_EVENTS = 3000;
const MAX_BYTES = 512 * 1024;
const MAX_TURN_MS = 2 * 60_000;
const KEEP_AFTER_DONE_MS = 3 * 60_000;
export const MAX_POLL_WAIT_MS = 8_000;

const turns = new Map<string, Turn>();

function sweep(now = Date.now()) {
  for (const [id, turn] of turns) {
    if ((turn.done && now - (turn.finishedAt ?? now) > KEEP_AFTER_DONE_MS) || now - turn.createdAt > MAX_TURN_MS + KEEP_AFTER_DONE_MS) {
      turn.controller.abort();
      turns.delete(id);
    }
  }
}
setInterval(() => sweep(), 30_000).unref();

function wake(turn: Turn) {
  for (const waiter of turn.waiters) waiter();
  turn.waiters.clear();
}

/** Starts a turn. A visitor has at most one running turn per shop: a newer question aborts the stale one. */
export function createTurn(shopId: string, visitorId: string): Turn {
  sweep();
  for (const turn of turns.values()) {
    if (!turn.done && turn.shopId === shopId && turn.visitorId === visitorId) cancel(turn, "superseded");
  }
  if (turns.size >= MAX_TURNS) {
    const oldest = [...turns.values()].sort((a, b) => a.createdAt - b.createdAt)[0]!;
    oldest.controller.abort();
    turns.delete(oldest.id);
  }
  const turn: Turn = {
    id: `${workerId}__${randomUUID().replaceAll("-", "")}`,
    shopId,
    visitorId,
    events: [],
    bytes: 0,
    done: false,
    controller: new AbortController(),
    waiters: new Set(),
    createdAt: Date.now(),
  };
  // A turn can never run longer than the hard limit, even if a provider hangs.
  setTimeout(() => { if (!turn.done) cancel(turn, "timeout"); }, MAX_TURN_MS).unref();
  turns.set(turn.id, turn);
  return turn;
}

export function emit(turn: Turn, event: TurnEvent) {
  if (turn.done) return;
  const size = JSON.stringify(event).length;
  if (turn.events.length >= MAX_EVENTS || turn.bytes + size > MAX_BYTES) {
    logAssistant("tool_validation_failure", { shop: turn.shopId, reason: "turn_buffer_full" });
    finish(turn, { type: "error", code: "PROVIDER_UNAVAILABLE" });
    turn.controller.abort();
    return;
  }
  turn.bytes += size;
  turn.events.push(event);
  wake(turn);
}

/** Marks a turn finished. A final event (done or error) is always the last one. */
export function finish(turn: Turn, last: TurnEvent = { type: "done" }) {
  if (turn.done) return;
  turn.events.push(last);
  turn.done = true;
  turn.finishedAt = Date.now();
  wake(turn);
}

function cancel(turn: Turn, reason: "cancelled" | "superseded" | "timeout") {
  turn.controller.abort();
  finish(turn, reason === "timeout" ? { type: "error", code: "PROVIDER_TIMEOUT" } : { type: "cancelled", reason });
}

function owned(shopId: string, visitorId: string, id: string) {
  const turn = turns.get(id);
  return turn && turn.shopId === shopId && turn.visitorId === visitorId ? turn : null;
}

/** Events after `after`, waiting up to `waitMs` for new ones. Null when the turn is unknown or not this visitor's. */
export async function readTurn(shopId: string, visitorId: string, id: string, after: number, waitMs = MAX_POLL_WAIT_MS) {
  const turn = owned(shopId, visitorId, id);
  if (!turn) return null;
  const from = Math.max(0, Math.floor(after) || 0);
  if (turn.events.length <= from && !turn.done) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { turn.waiters.delete(done); resolve(); }, Math.min(Math.max(0, waitMs), MAX_POLL_WAIT_MS));
      const done = () => { clearTimeout(timer); resolve(); };
      turn.waiters.add(done);
    });
  }
  return { events: turn.events.slice(from), next: turn.events.length, done: turn.done };
}

export function cancelTurn(shopId: string, visitorId: string, id: string) {
  const turn = owned(shopId, visitorId, id);
  if (!turn) return false;
  if (!turn.done) cancel(turn, "cancelled");
  return true;
}

/** Test hook. */
export function resetAssistantTurns() {
  for (const turn of turns.values()) turn.controller.abort();
  turns.clear();
}
