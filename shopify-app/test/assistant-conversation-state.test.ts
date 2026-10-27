/**
 * Conversation state regressions from the test-sofa-site QA screenshots (scenarios A–D). The scripted model repeats
 * the real model's mistakes; the server must correct them from structured state, never from the model's prose.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ configs: [] as any[] }));
vi.mock("../app/db.server", () => ({
  default: {
    appearance: { findFirst: vi.fn(async () => null) },
    productPreviewConfig: {
      findMany: vi.fn(async (args: any) => state.configs.filter((config) => config.shopId === args.where.shopId &&
        (!args.where.productId?.in || args.where.productId.in.includes(config.productId)))),
    },
    customizationConfig: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock("../app/auto-products.server", () => ({ ensureAutoProductConfig: vi.fn(async () => null) }));
vi.mock("../app/storefront.server", () => ({ storefrontConfig: vi.fn(async () => ({ enabled: false })) }));

import { answerRoomAssistant, runAssistantTurn, type AssistantEvent } from "../app/room-assistant.server";
import { resetAssistantCatalogueCache } from "../app/assistant/catalogue.server";
import { resetAssistantKnowledgeCache } from "../app/assistant/knowledge.server";
import { setAssistantLogSink } from "../app/assistant/log.server";
import { DEFAULT_ROOM_ASSISTANT_SETTINGS } from "../app/room-assistant-settings";
import { finalAnswer, fixtureAdmin, fixtureProduct, recommend, ref, scriptedModel, toolCall, toolOutputs } from "./fixtures/assistant-store";

const SHOP = "test-sofa-site.myshopify.com";
const settings = { ...DEFAULT_ROOM_ASSISTANT_SETTINGS, enabled: true };
setAssistantLogSink(() => {});

const single = { Title: ["Default Title"] };
// The products and prices from the screenshots, plus one adult bed within the $250 budget.
const egerie = fixtureProduct({ id: 9101, title: "Egerie Curved Headboard Beige Boucle Bed", productType: "Bed", options: single, price: 319.99 });
const cloud = fixtureProduct({ id: 9102, title: "Cloud Nine Upholstered kids", productType: "Bed", options: single, price: 239.99 });
const camden = fixtureProduct({ id: 9103, title: "Camden Bed", productType: "Bed", options: { Size: ["Double", "King"] }, price: (options) => options.Size === "King" ? 409.99 : 359.99 });
const pink = fixtureProduct({ id: 9104, title: "Pink Kids Bed Modern 2026", productType: "Bed", options: single, price: 239.99 });
const oslo = fixtureProduct({ id: 9105, title: "Oslo Oak Bed Frame", productType: "Bed", options: single, price: 229 });
const catalogue = [egerie, cloud, camden, pink, oslo];
const readyConfig = (productId: string) => ({
  id: `cfg-${productId}`, shopId: SHOP, productId, enabled: true, autoConfigured: true, visualOptionName: null, itemNoun: "bed",
  placement: "replace", setting: "indoor", frozenContext: {}, readiness: "ready", readinessReasons: [], referenceMediaId: null,
  referenceAngle: "front", choices: [], updatedAt: new Date(),
});
const card = (product: typeof egerie, variant = 0) => ({ productRef: ref(product.id), variantRef: ref(product.variants[variant]!.id) });
const shownFirst = [card(egerie), card(cloud), card(camden)];
const search = (extra: Record<string, unknown> = {}) => toolCall("search_products", {
  query: "bed", colour: null, size: null, material: null, style: null, minPrice: null, maxPrice: null, availableOnly: true, limit: 6, ...extra,
});
const developer = (requests: any[]) => requests[0].input.find((item: any) => item.role === "developer").content as string;

async function turn(client: any, messages: string[], extra: Record<string, unknown> = {}) {
  const history = messages.flatMap((content, index) => index === messages.length - 1 ? [{ role: "user" as const, content }] : [{ role: "user" as const, content }, { role: "assistant" as const, content: "OK." }]);
  const events: AssistantEvent[] = [];
  let reply: any;
  await runAssistantTurn({ admin: fixtureAdmin(catalogue), shopId: SHOP, history, client, env: {} as any, settings, ...extra }, (event) => {
    events.push(event);
    if (event.type === "final") reply = event.reply;
  });
  return { reply, events };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAssistantCatalogueCache();
  resetAssistantKnowledgeCache();
  state.configs = [readyConfig(egerie.id), readyConfig(oslo.id), readyConfig(pink.id)];
});

describe("Scenario A: a card selection is authoritative", () => {
  it("'select one' after choosing Cloud Nine on its card keeps Cloud Nine; the model cannot swap in Egerie", async () => {
    const { client, requests } = scriptedModel([
      toolCall("select_product", { productRef: ref(egerie.id), variantRef: null }, "call-wrong"),
      toolCall("select_product", { productRef: ref(cloud.id), variantRef: null }, "call-right"),
      finalAnswer("Cloud Nine it is."),
    ]);
    const { reply, events } = await turn(client, ["plz suggest some beds", "select one"], {
      shown: shownFirst, selected: { ...card(cloud), source: "card" },
    });
    expect(developer(requests)).toContain(`Selected product: productRef ${ref(cloud.id)}`);
    expect(developer(requests)).toContain("chosen by the shopper on its card");
    expect(toolOutputs(requests, "call-wrong")[0]).toMatchObject({ error: "reference_mismatch", expectedProductRef: ref(cloud.id) });
    expect(reply.selection).toEqual({ ...card(cloud), source: "card" });
    expect(events.filter((event) => event.type === "selected").map((event: any) => event.item.productRef)).toEqual([ref(cloud.id)]);
  });

  it("keeps the exact variant chosen on the card", async () => {
    const { client } = scriptedModel([toolCall("select_product", { productRef: ref(camden.id), variantRef: null }), finalAnswer("Done.")]);
    const { reply } = await turn(client, ["I like this one"], { shown: shownFirst, selected: { ...card(camden, 1), source: "card" } });
    expect(reply.selected).toMatchObject({ productRef: ref(camden.id), variantRef: ref(camden.variants[1]!.id), price: "409.99" });
  });
});

describe("Scenario B: budget and audience persist and are enforced", () => {
  it("turns '$250 budget' into a standing constraint applied to search and recommendations", async () => {
    const { client, requests } = scriptedModel([
      search(),
      // The real model recommended kids beds and an over-budget bed here.
      recommend([
        { ...card(cloud), reason: "" }, { ...card(egerie), reason: "" }, { ...card(oslo), reason: "" },
      ]),
      finalAnswer("Here is one within budget."),
    ]);
    const { reply } = await turn(client, ["plz suggest some beds", "my budget 250$"], { shown: shownFirst });
    const searched = toolOutputs(requests, "call-search_products")[0];
    expect(searched.appliedConstraints).toMatchObject({ budgetMax: 250, childrensProductsExcluded: 2 });
    expect(searched.results.map((entry: any) => entry.title)).toEqual(["Oslo Oak Bed Frame"]);
    expect(reply.recommendations.map((item: any) => item.title)).toEqual(["Oslo Oak Bed Frame"]);
    expect(toolOutputs(requests, "call-recommend_products")[0].excludedForShopperConstraints).toHaveLength(2);
    expect(reply.constraints).toEqual({ budgetMax: 250, budgetMin: null, budgetCurrency: "$", forChildren: false });
    expect(developer(requests)).toContain("Budget: up to 250");
  });

  it("keeps the budget on later turns that don't mention it, until the shopper changes it", async () => {
    const constraints = { budgetMax: 250, budgetMin: null, budgetCurrency: "$", forChildren: false };
    const later = scriptedModel([finalAnswer("OK.")]);
    const { reply } = await turn(later.client, ["show me grey ones"], { constraints });
    expect(reply.constraints).toEqual(constraints);
    expect(developer(later.requests)).toContain("Budget: up to 250");
    const raised = scriptedModel([finalAnswer("OK.")]);
    expect((await turn(raised.client, ["actually up to 400"], { constraints })).reply.constraints.budgetMax).toBe(400);
  });

  it("shows children's furniture once the shopper says it is for a child", async () => {
    const { client } = scriptedModel([search(), recommend([{ ...card(pink), reason: "" }]), finalAnswer("For her room.")]);
    const { reply } = await turn(client, ["it's for my daughter, budget 250"]);
    expect(reply.constraints.forChildren).toBe(true);
    expect(reply.recommendations.map((item: any) => item.title)).toEqual(["Pink Kids Bed Modern 2026"]);
  });

  it("honours an explicitly named over-budget product and says it is over budget", async () => {
    const { client, requests } = scriptedModel([toolCall("select_product", { productRef: ref(egerie.id), variantRef: null }), finalAnswer("It's $69.99 over.")]);
    const { reply } = await turn(client, ["show me Egerie"], { shown: shownFirst, constraints: { budgetMax: 250, budgetMin: null, budgetCurrency: "$", forChildren: false } });
    expect(reply.selected).toMatchObject({ productRef: ref(egerie.id) });
    expect(toolOutputs(requests, "call-select_product")[0].constraintNote).toContain("over the shopper's budget of $250");
  });

  it("'pick one for me' cannot pick a product that breaks the constraints", async () => {
    const { client, requests } = scriptedModel([
      toolCall("select_product", { productRef: ref(egerie.id), variantRef: null }, "call-bad"),
      toolCall("select_product", { productRef: ref(oslo.id), variantRef: null }, "call-good"),
      finalAnswer("Oslo: oak suits your floor and it's within budget."),
    ]);
    const { reply } = await turn(client, ["you choose"], {
      shown: [card(egerie), card(oslo)], constraints: { budgetMax: 250, budgetMin: null, budgetCurrency: "$", forChildren: false },
    });
    expect(toolOutputs(requests, "call-bad")[0]).toMatchObject({ selected: false, error: "does_not_fit" });
    expect(reply.selection).toEqual({ ...card(oslo), source: "conversation" });
  });
});

describe("Scenario C: ambiguous references", () => {
  it("'show me tha' never previews an old over-budget selection; the assistant must ask", async () => {
    const { client, requests } = scriptedModel([
      toolCall("request_visualisation", { productRef: ref(egerie.id), variantRef: null }),
      finalAnswer("Which one: Cloud Nine or Pink Kids?"),
    ]);
    const { reply, events } = await turn(client, ["beds for my daughter", "my budget 250$", "show me tha"], {
      shown: [card(cloud), card(pink)], selected: { ...card(egerie), source: "conversation" }, hasPhoto: true,
      constraints: { budgetMax: 250, budgetMin: null, budgetCurrency: "$", forChildren: true },
    });
    expect(toolOutputs(requests, "call-request_visualisation")[0]).toMatchObject({ offered: false, error: "ambiguous_reference" });
    expect(developer(requests)).toContain("ambiguous between");
    expect(reply.visualise).toBeNull();
    expect(events.some((event) => event.type === "visualise")).toBe(false);
  });

  it("resolves ordinals to the latest recommendations, not an older selection", async () => {
    const { client, requests } = scriptedModel([
      toolCall("select_product", { productRef: ref(egerie.id), variantRef: null }, "call-wrong"),
      toolCall("select_product", { productRef: ref(camden.id), variantRef: null }, "call-right"),
      finalAnswer("Camden."),
    ]);
    const { reply } = await turn(client, ["the third one"], { shown: shownFirst, selected: { ...card(egerie), source: "conversation" } });
    expect(toolOutputs(requests, "call-wrong")[0]).toMatchObject({ error: "reference_mismatch", expectedProductRef: ref(camden.id) });
    expect(reply.selection.productRef).toBe(ref(camden.id));
  });

  it("a correction ('no, I meant Camden') replaces the previous selection", async () => {
    const { client } = scriptedModel([toolCall("select_product", { productRef: ref(camden.id), variantRef: null }), finalAnswer("Camden.")]);
    const { reply } = await turn(client, ["select one", "no, I meant Camden"], { shown: shownFirst, selected: { ...card(egerie), source: "conversation" } });
    expect(reply.selection).toMatchObject({ productRef: ref(camden.id), source: "conversation" });
  });
});

describe("Scenario D: show the product vs preview it in the room", () => {
  it("'show me Cloud Nine' shows its card with the real photo even though it can't be previewed, and offers alternatives", async () => {
    const { client, requests } = scriptedModel([
      // The model repeats its earlier mistake: previewing Egerie.
      toolCall("request_visualisation", { productRef: ref(egerie.id), variantRef: null }, "call-wrong"),
      toolCall("request_visualisation", { productRef: ref(cloud.id), variantRef: null }, "call-right"),
      finalAnswer("Here's Cloud Nine. It can't be previewed yet."),
    ]);
    const { reply, events } = await turn(client, ["beds for my son", "Show me Cloud Nine"], {
      shown: [card(cloud), card(pink)], hasPhoto: true, constraints: { budgetMax: null, budgetMin: null, budgetCurrency: null, forChildren: true },
    });
    expect(toolOutputs(requests, "call-wrong")[0]).toMatchObject({ error: "reference_mismatch", expectedProductRef: ref(cloud.id) });
    const refused = toolOutputs(requests, "call-right")[0];
    expect(refused).toMatchObject({ offered: false, cardShown: true });
    expect(refused.previewableAlternatives.map((entry: any) => entry.title)).toEqual(["Pink Kids Bed Modern 2026"]);
    const shownCard = events.find((event) => event.type === "selected") as any;
    expect(shownCard.item).toMatchObject({ productRef: ref(cloud.id), previewAvailable: false });
    expect(shownCard.item.image).toBeTruthy();
    expect(reply.visualise).toBeNull();
    expect(reply.selected.productRef).toBe(ref(cloud.id));
  });

  it("'show it in my room' previews the selected, previewable product", async () => {
    const { client } = scriptedModel([toolCall("request_visualisation", { productRef: ref(oslo.id), variantRef: null }), finalAnswer("Confirm on the card.")]);
    const { reply } = await turn(client, ["show it in my room"], { shown: [card(oslo), card(egerie)], selected: { ...card(oslo), source: "card" }, hasPhoto: true });
    expect(reply.visualise).toMatchObject({ productRef: ref(oslo.id), previewAvailable: true });
  });
});

describe("state is rebuilt from structured data every turn", () => {
  it("survives a page refresh: the persisted selection and constraints alone restore the state", async () => {
    const { client, requests } = scriptedModel([finalAnswer("OK.")]);
    await answerRoomAssistant({
      admin: fixtureAdmin(catalogue), shopId: SHOP, client, env: {} as any, settings,
      history: [{ role: "user", content: "what size is it" }],
      shown: shownFirst, selected: { ...card(cloud), source: "card" }, constraints: { budgetMax: 250, budgetMin: null, budgetCurrency: "$", forChildren: false },
    });
    const context = developer(requests);
    expect(context).toContain(`Selected product: productRef ${ref(cloud.id)}`);
    expect(context).toContain("Budget: up to 250");
  });

  it("ignores malformed or forged state from the browser", async () => {
    const { client, requests } = scriptedModel([finalAnswer("OK.")]);
    const { reply } = await turn(client, ["Could you help me find a bed?"], { selected: { productRef: "gid://x", source: "admin" }, constraints: { budgetMax: -5, forChildren: "yes", budgetCurrency: "<b>" } });
    expect(reply.selection).toBeNull();
    expect(reply.constraints).toEqual({ budgetMax: null, budgetMin: null, budgetCurrency: null, forChildren: false });
    expect(developer(requests)).not.toContain("Selected product");
  });

  it("in a long conversation, an old product mentioned early does not override the latest card selection", async () => {
    const messages = ["show me Egerie", ...Array.from({ length: 12 }, (_, index) => `question ${index}`), "show it in my room"];
    const { client, requests } = scriptedModel([
      toolCall("request_visualisation", { productRef: ref(egerie.id), variantRef: null }, "call-stale"),
      toolCall("request_visualisation", { productRef: ref(oslo.id), variantRef: null }, "call-fresh"),
      finalAnswer("Confirm on the card."),
    ]);
    const { reply } = await turn(client, messages, { shown: [card(oslo), card(egerie)], selected: { ...card(oslo), source: "card" }, hasPhoto: true });
    expect(toolOutputs(requests, "call-stale")[0]).toMatchObject({ error: "reference_mismatch", expectedProductRef: ref(oslo.id) });
    expect(reply.visualise.productRef).toBe(ref(oslo.id));
  });
});
