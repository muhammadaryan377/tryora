import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let assistant: any;

beforeEach(async () => {
  vi.stubGlobal("localStorage", { getItem: () => "00000000-0000-4000-8000-000000000001", setItem: vi.fn() });
  const { RoomAssistant } = await import("../../packages/storefront/src/assistant");
  assistant = new RoomAssistant({
    enabled: true,
    configured: true,
    providerReady: true,
    greeting: "How can I help?",
    launcher: { label: "Room assistant", position: "bottom-right", colour: "#6f7046" },
  }, { productId: "gid://shopify/Product/1", openCurrentPreview: vi.fn() });
});

afterEach(() => vi.unstubAllGlobals());

describe("room assistant storefront", () => {
  it("renders all three workflows with an accessible fallback for current preview", () => {
    const html = assistant.home();
    expect(html).toContain('data-assistant-act="preview-current"');
    expect(html).toContain('data-assistant-act="recommend"');
    expect(html).toContain('data-assistant-act="chat"');
    expect(html).toContain("How can I help?");
  });

  it("sends the room photo only for recommendation analysis", async () => {
    assistant.photo = { blob: new Blob(["room"], { type: "image/jpeg" }), url: "blob:room" };
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const form = init.body as FormData;
      expect(form.get("photo")).toBeInstanceOf(Blob);
      expect(form.get("product")).toBe("gid://shopify/Product/1");
      return Response.json({ message: "One verified match.", room: null, recommendations: [] });
    });
    vi.stubGlobal("fetch", fetcher);
    await assistant.recommend();
    expect(assistant.history).toEqual([
      expect.objectContaining({ role: "user" }),
      { role: "assistant", content: "One verified match." },
    ]);
  });

  it("keeps bounded multi-turn history and resolves follow-up questions server-side", async () => {
    const histories: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const history = JSON.parse(String((init.body as FormData).get("history")));
      histories.push(history);
      return Response.json({ message: histories.length === 1 ? "First recommendation is Aria." : "The second is Aspen.", room: null, recommendations: [] });
    }));
    assistant.draft = "Which bed is best?";
    await assistant.chat();
    assistant.draft = "Show me the second recommendation";
    await assistant.chat();
    expect(histories[1]).toEqual([
      { role: "user", content: "Which bed is best?" },
      { role: "assistant", content: "First recommendation is Aria." },
      { role: "user", content: "Show me the second recommendation" },
    ]);
  });
});
