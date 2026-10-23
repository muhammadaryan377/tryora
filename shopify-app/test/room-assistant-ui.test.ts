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

  const recommendation = (overrides: Record<string, unknown>) => ({
    id: "1:11", productRef: "1", variantRef: "11", productId: "gid://shopify/Product/1", variantId: "gid://shopify/ProductVariant/11",
    title: "Aria Bed", url: "/products/aria?variant=11", image: null, price: "999.00", maxPrice: null, currencyCode: "GBP",
    options: { Colour: "Cream" }, purchaseAvailable: true, previewAvailable: true, previewStatus: "available", reason: "Suits the room.", ...overrides,
  });

  it("sends room notes and numbered recommendations so follow-ups resolve, without re-sending the photo", async () => {
    const forms: FormData[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      forms.push(init.body as FormData);
      return forms.length === 1
        ? Response.json({ message: "Two options.", room: { colours: ["white"], style: "Scandinavian", lighting: "bright", notes: "" },
          recommendations: [recommendation({}), recommendation({ id: "2:21", productRef: "2", variantRef: "21", title: "Aspen Bed" })] })
        : Response.json({ message: "Yes, in king.", room: null, recommendations: [] });
    }));
    assistant.photo = { blob: new Blob(["room"], { type: "image/jpeg" }), url: "blob:room" };
    await assistant.recommend();
    assistant.draft = "Does the second one come in king size?";
    await assistant.chat();
    expect(forms[1]!.get("photo")).toBeNull();
    expect(JSON.parse(String(forms[1]!.get("room")))).toEqual({ colours: ["white"], style: "Scandinavian", lighting: "bright", notes: "" });
    expect(JSON.parse(String(forms[1]!.get("shown")))).toEqual([{ productRef: "1", variantRef: "11" }, { productRef: "2", variantRef: "21" }]);
    // A text-only answer keeps the earlier room notes and numbered options.
    expect(assistant.session.room.style).toBe("Scandinavian");
    expect(assistant.session.shown).toHaveLength(2);
  });

  it("labels purchase and AI-preview availability separately and only links verified previews to the popup", () => {
    assistant.reply = { message: "", room: null, recommendations: [
      recommendation({}),
      recommendation({ id: "3:", productRef: "3", variantRef: null, title: "Oslo Couch", url: "/products/oslo", previewAvailable: false, previewStatus: "not_configured", price: "799.00", maxPrice: "899.00" }),
      recommendation({ id: "4:41", productRef: "4", title: "Luna Chair", url: "/products/luna?variant=41", purchaseAvailable: false, previewAvailable: false, previewStatus: "unavailable" }),
    ] };
    const html = assistant.recommendations();
    expect(html).toContain('href="/products/aria?variant=11#tryora"');
    expect(html).toContain('href="/products/oslo"');
    expect(html).toContain('href="/products/luna?variant=41"');
    expect(html.match(/AI room preview available/g)).toHaveLength(1);
    expect(html.match(/AI room preview not available/g)).toHaveLength(2);
    expect(html).toContain("Currently sold out");
    expect(html.match(/Available to buy/g)).toHaveLength(2);
    expect(html).toMatch(/799\.00.*–.*899\.00/);
  });

  it("lets the shopper forget the room notes and keeps working when browser storage is unavailable", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("sessionStorage", { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value), removeItem: (key: string) => store.delete(key) });
    assistant.absorb({ message: "ok", room: { colours: ["green"], style: "modern", lighting: "soft", notes: "" }, recommendations: [] });
    expect(JSON.parse(store.get("tryora_assistant_context")!).room.style).toBe("modern");
    expect(assistant.chatScreen()).toContain("Using your room: modern, green");
    assistant.onClick({ target: { closest: () => ({ dataset: { assistantAct: "forget-room" } }) } });
    expect(assistant.session.room).toBeNull();
    expect(store.has("tryora_assistant_context")).toBe(false);
    vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } });
    expect(() => assistant.absorb({ message: "ok", room: { colours: [], style: "classic", lighting: "", notes: "" }, recommendations: [] })).not.toThrow();
  });

  it("explains timeouts to shoppers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "PROVIDER_TIMEOUT" }, { status: 503 })));
    assistant.draft = "Which bed?";
    await assistant.chat();
    expect(assistant.error).toMatch(/took too long/);
  });
});
