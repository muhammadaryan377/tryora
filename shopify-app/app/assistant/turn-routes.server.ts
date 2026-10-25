/**
 * App-proxy handlers for streamed Room Assistant turns.
 *
 *   POST assistant/turn            start a turn, returns { turnId }
 *   GET  assistant/turn/<id>       long-poll events after ?after=<n> (incremental even if the proxy buffers)
 *   POST assistant/turn/<id>/cancel
 *   POST assistant/stream          the same events as Server-Sent Events (opt-in transport)
 *
 * Every request has already passed authenticate.public.appProxy; turns are additionally bound to shop + visitor.
 */
import { TryoraError } from "../core/index";
import type { AdminGraphql } from "../preview-product.server";
import { remoteWorker } from "../preview-worker.server";
import { guardAssistant } from "../guard.server";
import {
  normaliseAssistantHistory,
  requireAssistantEnabled,
  runAssistantTurn,
  type AssistantTurnInput,
} from "../room-assistant.server";
import { cancelTurn, createTurn, emit, finish, MAX_POLL_WAIT_MS, readTurn, type Turn } from "./turns.server";
import { errorShape, logAssistant } from "./log.server";

const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const TURN_ID = /^[A-Za-z0-9]{1,40}_[a-f0-9]{32}__[a-f0-9]{32}$/;
const VISITOR = /^[0-9a-f-]{36}$/i;

const LIMITS: Record<string, number> = { history: 30_000, room: 4_000, shown: 2_000, explored: 3_000, selected: 400, preferences: 2_000, earlier: 1_500, constraints: 400 };

/** Parses and bounds a turn request. Throws BAD_REQUEST / BAD_PHOTO for anything malformed. */
export async function assistantInputFrom(form: FormData, admin: AdminGraphql, shopId: string): Promise<AssistantTurnInput> {
  const field = (key: string) => String(form.get(key) ?? "");
  for (const [key, limit] of Object.entries(LIMITS)) if (field(key).length > limit) throw new TryoraError("BAD_REQUEST");
  const parsed = (key: string) => {
    if (!field(key)) return undefined;
    try { return JSON.parse(field(key)); } catch { throw new TryoraError("BAD_REQUEST"); }
  };
  let photo: Uint8Array | undefined;
  if (form.has("photo")) {
    const file = form.get("photo");
    if (!file || typeof file === "string" || file.size > MAX_PHOTO_BYTES) throw new TryoraError("BAD_PHOTO");
    photo = new Uint8Array(await file.arrayBuffer());
  }
  return {
    admin,
    shopId,
    history: normaliseAssistantHistory(parsed("history")),
    currentProductId: field("product") || undefined,
    roomPhoto: photo,
    hasPhoto: field("hasPhoto") === "1",
    room: parsed("room") ?? null,
    shown: parsed("shown") ?? [],
    explored: parsed("explored") ?? [],
    selected: parsed("selected") ?? null,
    preferences: parsed("preferences") ?? null,
    earlier: parsed("earlier") ?? [],
    constraints: parsed("constraints") ?? null,
  };
}

function runInBackground(turn: Turn, input: AssistantTurnInput) {
  void runAssistantTurn({ ...input, signal: turn.controller.signal }, (event) => emit(turn, event))
    .then(() => finish(turn))
    .catch((error) => {
      if (turn.controller.signal.aborted) return; // Already finished as cancelled or timed out.
      const code = error instanceof TryoraError ? error.code : "PROVIDER_UNAVAILABLE";
      if (!(error instanceof TryoraError)) logAssistant("openai_failure", { shop: turn.shopId, stage: "turn", ...errorShape(error) });
      finish(turn, { type: "error", code });
    });
}

export async function startAssistantTurn(admin: AdminGraphql, shopId: string, form: FormData) {
  const visitor = String(form.get("visitor") ?? "");
  guardAssistant(shopId, visitor);
  const settings = await requireAssistantEnabled(shopId);
  const input = await assistantInputFrom(form, admin, shopId);
  const turn = createTurn(shopId, visitor);
  runInBackground(turn, { ...input, settings });
  return { turnId: turn.id };
}

/** Long-poll read. Routed to the owning worker when several instances share TRYORA_WORKER_ORIGINS. */
export async function readAssistantTurn(shopId: string, visitor: string, id: string, after: number) {
  if (!TURN_ID.test(id) || !VISITOR.test(visitor)) throw new TryoraError("NOT_FOUND");
  const remote = await remoteWorker("assistant_events", id, { shopId, visitor, turnId: id, after }, MAX_POLL_WAIT_MS + 2_000);
  const result = remote ?? await readTurn(shopId, visitor, id, after);
  if (!result) throw new TryoraError("NOT_FOUND");
  return result;
}

export async function cancelAssistantTurn(shopId: string, visitor: string, id: string) {
  if (!TURN_ID.test(id) || !VISITOR.test(visitor)) throw new TryoraError("NOT_FOUND");
  const remote = await remoteWorker("assistant_cancel", id, { shopId, visitor, turnId: id });
  return { cancelled: remote?.cancelled ?? cancelTurn(shopId, visitor, id) };
}

/** Local handlers for the internal worker route. */
export async function workerAssistantOperation(body: any) {
  if (typeof body.shopId !== "string" || typeof body.visitor !== "string" || typeof body.turnId !== "string") return null;
  if (body.operation === "assistant_events") return readTurn(body.shopId, body.visitor, body.turnId, Number(body.after) || 0);
  if (body.operation === "assistant_cancel") return { cancelled: cancelTurn(body.shopId, body.visitor, body.turnId) };
  return null;
}

/**
 * Server-Sent Events for the same turn. The opening comment pads past common proxy buffering thresholds; whether
 * Shopify's app proxy forwards chunks unbuffered must be confirmed on a real store before enabling this transport.
 */
export async function streamAssistantTurn(admin: AdminGraphql, shopId: string, form: FormData): Promise<Response> {
  const { turnId } = await startAssistantTurn(admin, shopId, form);
  const visitor = String(form.get("visitor") ?? "");
  const encoder = new TextEncoder();
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(`:${" ".repeat(2048)}\n\n`));
      controller.enqueue(encoder.encode(`event: turn\ndata: ${JSON.stringify({ turnId })}\n\n`));
      let after = 0;
      while (!closed) {
        const result = await readTurn(shopId, visitor, turnId, after, 15_000);
        if (!result) break;
        for (const event of result.events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        after = result.next;
        if (result.done) break;
        if (!result.events.length) controller.enqueue(encoder.encode(": keep-alive\n\n"));
      }
      if (!closed) controller.close();
    },
    cancel() {
      closed = true;
      cancelTurn(shopId, visitor, turnId);
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}
