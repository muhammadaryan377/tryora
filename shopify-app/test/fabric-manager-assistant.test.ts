import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { providerFixture, shopId, productId } from "./fixtures/provider-mapping";
const state = vi.hoisted(() => ({ context: null as any, preview: null as any }));
vi.mock("../app/storefront.server", () => ({ storefrontConfig: vi.fn(async () => state.preview) }));
vi.mock("../app/auto-products.server", () => ({ ensureAutoProductConfig: vi.fn(async () => state.context.config) }));
vi.mock("../app/db.server", () => ({ default: {
  appearance: { findFirst: vi.fn(async () => null) }, productPreviewConfig: { findMany: vi.fn(async () => [state.context.config]) },
  customizationConfig: { findMany: vi.fn(async () => [state.context.setting]) },
} }));
import { productOptionsForAssistant } from "../app/assistant/options.server";
import { answerRoomAssistant } from "../app/room-assistant.server";
import { DEFAULT_ROOM_ASSISTANT_SETTINGS } from "../app/room-assistant-settings";
import { resetAssistantCatalogueCache } from "../app/assistant/catalogue.server";
import { setAssistantLogSink } from "../app/assistant/log.server";
import { draftFromMapping, compileFabricDocument } from "../app/customization/fabric-manager.server";
import { manualStorefrontData } from "../app/customization/validation.server";
import { valuesFor, cardForVariant, resolveVariant } from "../../packages/storefront/src/assistant/options";
import { fixtureProduct, fixtureAdmin, scriptedModel, toolCall, finalAnswer } from "./fixtures/assistant-store";
let admin: ReturnType<typeof fixtureAdmin>;
beforeEach(async () => {
  vi.stubEnv("TRYORA_CUSTOMIZATION_PROVIDERS_ENABLED", "true"); resetAssistantCatalogueCache(); setAssistantLogSink(() => {});
  const f = providerFixture();
  const draft = draftFromMapping(f.mapping, shopId, productId);
  const compiled = compileFabricDocument(draft, shopId, productId, { product: {}, variants: f.variants, media: f.media });
  state.context = { ...f.context, setting: { ...f.context.setting, mapping: compiled.document } };
  state.preview = { enabled: true, available: true, ...await manualStorefrontData(state.context), lead: { mode: "required", timing: "before" } };
  const product = fixtureProduct({ id: 1, title: "Synthetic Bed", productType: "Bed", options: { Title: ["Default Title"] } });
  product.options = f.mapping.entries[0] ? Object.keys(f.mapping.entries[0].nativeOptions).map((name) => ({ name, optionValues: [...new Set(f.mapping.entries.map((e) => e.nativeOptions[name]!))].map((name) => ({ name })) })) : [];
  product.variants = f.variants.map((v) => ({ ...v, title: "", price: "700.00", compareAtPrice: null })); product.media = f.media.map((m) => ({ id: m.id, url: m.image.url }));
  admin = fixtureAdmin([product]);
});
afterEach(() => vi.unstubAllEnvs());
const ask = (selected?: any, currentProductId?: string) => {
  const model = scriptedModel([toolCall("request_visualisation", { productRef: "1", variantRef: "12" }), finalAnswer("Confirm to create the preview.")]);
  return answerRoomAssistant({ admin, shopId, selected, currentProductId, history: [{ role: "user", content: "Show this bed in grey in my room" }], hasPhoto: true,
    client: model.client, env: {} as any, settings: { ...DEFAULT_ROOM_ASSISTANT_SETTINGS, enabled: true } });
};
describe("managed manual configurations in Room Assistant", () => {
  it("passes saved swatch appearance to the chat option selector", async () => {
    state.preview.swatchAppearance = { shape: "rectangle", size: 75 };
    const data = await productOptionsForAssistant(admin, shopId, productId);
    expect(data.swatchAppearance).toEqual({ shape: "rectangle", size: 75 });
  });
  it("offers only exact reviewed native combinations and locks the source size/storage", async () => {
    const data = await productOptionsForAssistant(admin, shopId, productId, "gid://shopify/ProductVariant/11");
    expect(data.variants.find((v) => v.id.endsWith("/12"))).toMatchObject({ previewOption: expect.any(String), referenceImage: "https://cdn.shopify.com/102.jpg", previewContext: { mappingRevision: "revision-1", sourceVariantId: "gid://shopify/ProductVariant/11" } });
    expect(data.variants.find((v) => v.id.endsWith("/13"))!.previewOption).toBeNull();
    expect(data.variants.find((v) => v.id.endsWith("/14"))!.previewOption).toBeNull();
    await expect(productOptionsForAssistant(admin, shopId, productId, "gid://shopify/ProductVariant/999")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const v = data.variants.find((v) => v.id.endsWith("/12"))!;
    expect(resolveVariant(data, v.values)?.id).toBe(v.id);
    const card = cardForVariant({ productRef: "1" } as any, data, v, true);
    expect(card.options).toEqual(v.options); expect(card.variantId).toBe(v.id);
    expect(card.previewContext?.sourceVariantId).toBe("gid://shopify/ProductVariant/11");
  });
  it("uses a different real sample for the same colour name under each fabric", () => {
    const data: any = { attributes: [{ name: "Fabric", kind: "fabric", values: [{ value: "Velvet", image: "velvet.jpg" }, { value: "Boucle", image: "boucle.jpg" }] },
      { name: "Colour", kind: "colour", values: [{ value: "Ascot", colour: null, image: null, samples: { Velvet: { image: "velvet-ascot.jpg", colour: null }, Boucle: { image: "boucle-ascot.jpg", colour: null } } }] }],
      variants: ["Velvet", "Boucle"].map((Fabric) => ({ values: { Fabric, Colour: "Ascot", Size: "King" }, available: true })) };
    expect(valuesFor(data, data.attributes[1], { Fabric: "Velvet" })[0]?.image).toBe("velvet-ascot.jpg");
    expect(valuesFor(data, data.attributes[1], { Fabric: "Boucle" })[0]?.image).toBe("boucle-ascot.jpg");
  });
  it("does not treat inherited sample keys as merchant-provided colours", () => {
    const data: any = { attributes: [{ name: "Fabric", kind: "fabric", values: [{ value: "constructor" }] }, { name: "Colour", kind: "colour", values: [{ value: "Ascot", image: null, colour: null, samples: {} }] }], variants: [] };
    expect(valuesFor(data, data.attributes[1], { Fabric: "constructor" })).toEqual([]);
  });
  it("validates a natural follow-up through the same provider/reference adapter before offering the card", async () => {
    const reply = await ask({ productRef: "1", variantRef: "11", source: "options" });
    expect(reply.visualise).toMatchObject({ productId, variantId: "gid://shopify/ProductVariant/12", previewAvailable: true,
      referenceImage: "https://cdn.shopify.com/102.jpg", previewContext: { mappingRevision: "revision-1", sourceVariantId: "gid://shopify/ProductVariant/11" } });
  });
  it("requires a source choice on the current page and rejects conflicting size/storage sources", async () => {
    expect((await ask(undefined, productId)).visualise).toBeNull();
    expect((await ask({ productRef: "1", variantRef: "14", source: "options" })).visualise).toBeNull();
  });
});
