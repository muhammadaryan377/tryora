import { describe, expect, it } from "vitest";
import { emptyState, historyFor, type Recommendation } from "../../packages/storefront/src/assistant/session";

describe("completed preview conversation context", () => {
  it("informs the assistant that a preview was delivered before positive feedback", () => {
    const state = emptyState("demo.myshopify.com");
    const item = { title: "Chelsea Luxe Bed", productRef: "101", variantRef: "202" } as Recommendation;
    state.entries = [
      { id: "u1", kind: "user", text: "Show this bed in my room", photo: true, at: 1 },
      { id: "a1", kind: "assistant", replyTo: "u1", text: "Here is the preview option.", status: "done", recommendations: [], visualise: null, at: 2 },
      { id: "p1", kind: "preview", item, status: "ready", at: 3 },
      { id: "u2", kind: "user", text: "ok ye acha laga", photo: false, at: 4 },
    ];
    const history = historyFor(state, "u2");
    expect(history.at(-2)?.role).toBe("assistant");
    expect(history.at(-2)?.content).toContain("AI room preview already generated and shown for Chelsea Luxe Bed");
    expect(history.at(-1)).toEqual({ role: "user", content: "ok ye acha laga" });
    expect(JSON.stringify(history)).not.toContain("blob:");
  });
});
