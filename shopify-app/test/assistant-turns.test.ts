import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ copy: { assistant: { enabled: true, pages: { product: true, home: true } } } as any }));
vi.mock("../app/db.server", () => ({
  default: {
    appearance: { findFirst: vi.fn(async () => ({ copy: state.copy })) },
    productPreviewConfig: { findMany: vi.fn(async () => []) },
    customizationConfig: { findMany: vi.fn(async () => []) },
  },
}));

import { cancelTurn, createTurn, emit, finish, readTurn, resetAssistantTurns } from "../app/assistant/turns.server";
import {
  assistantInputFrom,
  cancelAssistantTurn,
  readAssistantTurn,
  startAssistantTurn,
  streamAssistantTurn,
  workerAssistantOperation,
} from "../app/assistant/turn-routes.server";
import { setAssistantClientForTests } from "../app/room-assistant.server";
import { resetAssistantCatalogueCache } from "../app/assistant/catalogue.server";
import { setAssistantLogSink } from "../app/assistant/log.server";
import { finalAnswer, fixtureAdmin, fixtureProduct, toolCall } from "./fixtures/assistant-store";

setAssistantLogSink(() => {});
const SHOP = "demo.myshopify.com";
const VISITOR = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const bed = fixtureProduct({ id: 7, title: "Luna Bed", productType: "Bed", options: { Colour: ["Grey"] }, price: 450 });

const form = (fields: Record<string, string | Blob>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};
const history = JSON.stringify([{ role: "user", content: "Do you have grey beds?" }]);

/** A model that streams its final answer slowly, one delta every `gapMs`. */
function slowStreamingModel(gapMs: number, onAbort?: () => void) {
  let call = 0;
  return {
    responses: {
      create: async (_body: any, options: any) => {
        call += 1;
        options.signal?.addEventListener("abort", () => onAbort?.());
        if (call === 1) return toolCall("search_products", { query: "bed", colour: "grey", size: null, material: null, style: null, minPrice: null, maxPrice: null, availableOnly: false, limit: 3 });
        return {
          async *[Symbol.asyncIterator]() {
            for (const delta of ["Yes, ", "the Luna ", "bed comes ", "in grey."]) {
              await new Promise((resolve) => setTimeout(resolve, gapMs));
              if (options.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "APIUserAbortError" });
              yield { type: "response.output_text.delta", delta };
            }
            yield { type: "response.completed", response: finalAnswer("Yes, the Luna bed comes in grey.") };
          },
        };
      },
    },
  } as any;
}

beforeEach(() => {
  resetAssistantTurns();
  resetAssistantCatalogueCache();
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  vi.stubEnv("OPENAI_ASSISTANT_PRIVACY_ACKNOWLEDGED", "true");
});
afterEach(() => { setAssistantClientForTests(null); vi.unstubAllEnvs(); });

describe("turn event buffers", () => {
  it("wakes a waiting long-poll as soon as an event is emitted", async () => {
    const turn = createTurn(SHOP, VISITOR);
    const started = Date.now();
    const reading = readTurn(SHOP, VISITOR, turn.id, 0, 5_000);
    setTimeout(() => emit(turn, { type: "delta", text: "Hi" }), 30);
    const result = await reading;
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result).toEqual({ events: [{ type: "delta", text: "Hi" }], next: 1, done: false });
    finish(turn);
    expect(await readTurn(SHOP, VISITOR, turn.id, 1)).toEqual({ events: [{ type: "done" }], next: 2, done: true });
  });

  it("is invisible to other visitors and other shops", async () => {
    const turn = createTurn(SHOP, VISITOR);
    emit(turn, { type: "delta", text: "private" });
    expect(await readTurn(SHOP, OTHER, turn.id, 0, 0)).toBeNull();
    expect(await readTurn("other.myshopify.com", VISITOR, turn.id, 0, 0)).toBeNull();
    expect(cancelTurn(SHOP, OTHER, turn.id)).toBe(false);
    expect(turn.done).toBe(false);
  });

  it("aborts a visitor's stale turn when they ask a new question", () => {
    const first = createTurn(SHOP, VISITOR);
    const second = createTurn(SHOP, VISITOR);
    expect(first.controller.signal.aborted).toBe(true);
    expect(first.events.at(-1)).toEqual({ type: "cancelled", reason: "superseded" });
    expect(second.controller.signal.aborted).toBe(false);
    // Another visitor's turn is unaffected.
    const other = createTurn(SHOP, OTHER);
    expect(second.controller.signal.aborted).toBe(false);
    expect(other.id).toMatch(/^[A-Za-z0-9]+_[a-f0-9]{32}__[a-f0-9]{32}$/);
  });

  it("bounds the buffer and ends an oversized turn with an error", () => {
    const turn = createTurn(SHOP, VISITOR);
    for (let i = 0; i < 400; i += 1) emit(turn, { type: "delta", text: "x".repeat(2_000) });
    expect(turn.done).toBe(true);
    expect(turn.controller.signal.aborted).toBe(true);
    expect(turn.events.at(-1)).toEqual({ type: "error", code: "PROVIDER_UNAVAILABLE" });
  });
});

describe("app proxy turn handlers", () => {
  it("validates and bounds request fields", async () => {
    const admin = fixtureAdmin([bed]);
    await expect(assistantInputFrom(form({ history: "x".repeat(30_001) }), admin, SHOP)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(assistantInputFrom(form({ history, room: "{bad" }), admin, SHOP)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(assistantInputFrom(form({ history, photo: new Blob([new Uint8Array(8 * 1024 * 1024 + 1)]) }), admin, SHOP)).rejects.toMatchObject({ code: "BAD_PHOTO" });
    const input = await assistantInputFrom(form({ history, product: "gid://shopify/Product/7", hasPhoto: "1", shown: JSON.stringify([{ productRef: "7", variantRef: null }]) }), admin, SHOP);
    expect(input).toMatchObject({ currentProductId: "gid://shopify/Product/7", hasPhoto: true, shown: [{ productRef: "7", variantRef: null }] });
  });

  it("delivers model text incrementally through long-polling, before the answer has finished", async () => {
    setAssistantClientForTests(() => slowStreamingModel(120));
    const { turnId } = await startAssistantTurn(fixtureAdmin([bed]), SHOP, form({ visitor: VISITOR, history }));
    const seen: any[] = [];
    let after = 0;
    let firstDeltaWhileRunning = false;
    for (let polls = 0; polls < 40; polls += 1) {
      const result = await readAssistantTurn(SHOP, VISITOR, turnId, after);
      seen.push(...result.events);
      if (result.events.some((event: any) => event.type === "delta") && !result.done) firstDeltaWhileRunning = true;
      after = result.next;
      if (result.done) break;
    }
    expect(firstDeltaWhileRunning).toBe(true);
    expect(seen.filter((event) => event.type === "delta").map((event) => event.text).join("")).toBe("Yes, the Luna bed comes in grey.");
    expect(seen.at(-2)).toMatchObject({ type: "final", reply: { message: "Yes, the Luna bed comes in grey." } });
    expect(seen.at(-1)).toEqual({ type: "done" });
    await expect(readAssistantTurn(SHOP, OTHER, turnId, 0)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("cancels the model call when the shopper presses Stop", async () => {
    let aborted = false;
    setAssistantClientForTests(() => slowStreamingModel(200, () => { aborted = true; }));
    const { turnId } = await startAssistantTurn(fixtureAdmin([bed]), SHOP, form({ visitor: VISITOR, history }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await cancelAssistantTurn(SHOP, VISITOR, turnId)).toEqual({ cancelled: true });
    const result = await readAssistantTurn(SHOP, VISITOR, turnId, 0);
    expect(result.done).toBe(true);
    expect(result.events.at(-1)).toEqual({ type: "cancelled", reason: "cancelled" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(aborted).toBe(true);
  });

  it("refuses turns while the assistant is disabled or for malformed visitors", async () => {
    state.copy = { assistant: { enabled: false } };
    await expect(startAssistantTurn(fixtureAdmin([bed]), SHOP, form({ visitor: VISITOR, history }))).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    state.copy = { assistant: { enabled: true, pages: { product: true } } };
    await expect(startAssistantTurn(fixtureAdmin([bed]), SHOP, form({ visitor: "not-a-visitor", history }))).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(readAssistantTurn(SHOP, VISITOR, "../../etc", 0)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("streams the same events as Server-Sent Events", async () => {
    setAssistantClientForTests(() => slowStreamingModel(20));
    const response = await streamAssistantTurn(fixtureAdmin([bed]), SHOP, form({ visitor: VISITOR, history }));
    expect(response.headers.get("Content-Type")).toMatch(/text\/event-stream/);
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");
    const text = await response.text();
    const events = text.split("\n\n").filter((block) => block.includes("data: ") && !block.includes("event: turn")).map((block) => JSON.parse(block.slice(block.indexOf("data: ") + 6)));
    expect(text).toMatch(/event: turn\ndata: \{"turnId":"[^"]+"\}/);
    expect(events.filter((event) => event.type === "delta")).toHaveLength(4);
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("serves routed reads for the owning worker", async () => {
    const turn = createTurn(SHOP, VISITOR);
    emit(turn, { type: "status", stage: "understanding" });
    expect(await workerAssistantOperation({ operation: "assistant_events", shopId: SHOP, visitor: VISITOR, turnId: turn.id, after: 0 }))
      .toMatchObject({ events: [{ type: "status" }], done: false });
    expect(await workerAssistantOperation({ operation: "assistant_events", shopId: SHOP, visitor: OTHER, turnId: turn.id })).toBeNull();
    expect(await workerAssistantOperation({ operation: "assistant_cancel", shopId: SHOP, visitor: VISITOR, turnId: turn.id })).toEqual({ cancelled: true });
    expect(await workerAssistantOperation({ operation: "nope", shopId: SHOP, visitor: VISITOR, turnId: turn.id })).toBeNull();
  });
});
