"""Conservative, reviewable Tryora chatbot behaviour fix.
Run from the root of the tryora repository: python tryora_chatbot_fix.py
Only edits the assistant and its UI test; does not push or deploy anything.
"""
from pathlib import Path
import sys

ROOT = Path.cwd()
EDITS: dict[str, list[tuple[str, str]]] = {
    "packages/storefront/src/assistant/drawer.ts": [
        (
            '''    const textarea = this.textarea();
    if (textarea && !textarea.value.trim()) {
      if (this.pendingIntent === "recommend") textarea.value = "Which furniture from this store would suit this room?";
      if (this.pendingIntent === "visualise") textarea.value = this.context.productId ? "Show this product in my room." : "Show me how a product would look in this room.";
      this.autosize();
    }
    textarea?.focus();''',
            '''    // Keep the composer empty after photo upload; do not overwrite shopper text.
    // The chosen welcome-card intent is handled only when Send is pressed.
    this.textarea()?.focus();'''
        )
    ],
    "packages/storefront/src/assistant/session.ts": [
        (
            '''    else if (entry.kind === "assistant" && entry.status === "done" && entry.text.trim()) {
      messages.push({ role: "assistant", content: entry.text.slice(0, 2000) });
    }
  }
  // The server requires alternating context ending with the shopper; drop unanswered earlier questions.''',
            r'''    else if (entry.kind === "assistant" && entry.status === "done" && entry.text.trim()) {
      messages.push({ role: "assistant", content: entry.text.slice(0, 2000) });
    }
    else if (entry.kind === "preview" && entry.status === "ready") {
      // The model must know when a preview was really displayed, not merely suggested.
      const note = `AI room preview already generated and shown for ${entry.item.title} (productRef ${entry.item.productRef}${entry.item.variantRef ? `, variantRef ${entry.item.variantRef}` : ""}).`;
      const previous = messages.at(-1);
      if (previous?.role === "assistant") previous.content = `${previous.content}\n${note}`.slice(-2000);
      else messages.push({ role: "assistant", content: note });
    }
  }
  // The server requires alternating context ending with the shopper; drop unanswered earlier questions.'''
        )
    ],
    "shopify-app/app/room-assistant.server.ts": [
        (
            '''- When the shopper shows interest in one product ("I like the first one"), call select_product. Use get_product_details to check another fabric or colour of the selected product.
- When the shopper states a budget, colours, materials, sizes, room dimensions or facts about their room, call update_shopper_context, and apply saved preferences to later searches.''',
            '''- When the shopper shows interest in a product they have not yet previewed ("I like the first one"), call select_product. Use get_product_details to check another fabric or colour of the selected product.
- When recent history records a completed AI room preview and the shopper simply reacts positively ("looks great", "I like it", "ok ye acha laga"), acknowledge it naturally. Do not call select_product, recommend_products or request_visualisation merely to show the same product card or suggest the same preview again. Offer a brief next step such as viewing product details only if relevant. Only offer a new preview when the shopper explicitly requests it.
- When the shopper states a budget, colours, materials, sizes, room dimensions or facts about their room, call update_shopper_context, and apply saved preferences to later searches.'''
        )
    ],
    "shopify-app/test/room-assistant-ui.test.ts": [
        (
            '''    expect(($("textarea") as HTMLTextAreaElement).value).toBe("Which furniture from this store would suit this room?");''',
            '''    expect(($("textarea") as HTMLTextAreaElement).value).toBe("");'''
        ),
        (
            '''    expect(($("textarea") as HTMLTextAreaElement).value).toBe("Show this product in my room.");''',
            '''    expect(($("textarea") as HTMLTextAreaElement).value).toBe("");'''
        ),
    ],
}

# Strict all-or-nothing validation: no writes if source differs from the reviewed GitHub code.
staged: dict[Path, str] = {}
for relative, pairs in EDITS.items():
    path = ROOT / relative
    if not path.is_file():
        sys.exit(f"STOP: missing {relative}. Run from the Tryora repository root.")
    text = path.read_text(encoding="utf-8")
    for before, after in pairs:
        n = text.count(before)
        if n == 1:
            text = text.replace(before, after)
        elif n == 0 and after in text:
            print(f"Already applied: {relative}")
        else:
            sys.exit(f"STOP: unexpected source in {relative} (match count {n}); nothing written.")
    staged[path] = text
# Regression test: the model-facing history contains the delivered preview before the shopper's reaction.
TEST_PATH = ROOT / "shopify-app/test/room-assistant-preview-history.test.ts"
TEST_CONTENT = r'''import { describe, expect, it } from "vitest";
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
'''
if TEST_PATH.exists() and TEST_PATH.read_text(encoding="utf-8") != TEST_CONTENT:
    sys.exit(f"STOP: {TEST_PATH} already exists with different contents; nothing written.")

for path, content in staged.items():
    path.write_text(content, encoding="utf-8")
    print(f"Updated: {path.relative_to(ROOT)}")
if not TEST_PATH.exists():
    TEST_PATH.write_text(TEST_CONTENT, encoding="utf-8")
    print(f"Added test: {TEST_PATH.relative_to(ROOT)}")
print("Done locally. No Git commit, push, merge or deployment was performed.")
