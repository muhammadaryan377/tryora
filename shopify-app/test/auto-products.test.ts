import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  config: null as any,
  autoEnabled: true,
}));
vi.mock("../app/db.server", () => ({
  default: {
    productPreviewConfig: {
      findUnique: vi.fn(async () => state.config),
      upsert: vi.fn(async ({ create, update }: any) => ({
        id: "auto-config", ...(state.config ? { ...state.config, ...update } : create),
      })),
    },
    shop: { findUnique: vi.fn(async () => ({ autoEnableProducts: state.autoEnabled })) },
  },
}));
import prisma from "../app/db.server";
import { autoFurnitureCategory, isAutoEligibleProduct, ensureAutoProductConfig } from "../app/auto-products.server";

const product = (overrides: Record<string, any> = {}) => ({
  id: "gid://shopify/Product/8",
  title: "Egerie Curved Headboard Boucle Bed",
  productType: "Beds",
  status: "ACTIVE",
  media: { nodes: [{ id: "gid://shopify/MediaImage/100", image: { url: "https://cdn.shopify.com/product.jpg" } }] },
  options: [{ name: "Colour" }],
  ...overrides,
});
const admin = (p: any = product()) => ({
  graphql: vi.fn(async () => Response.json({ data: { product: p } })),
});

beforeEach(() => {
  vi.clearAllMocks();
  state.config = null;
  state.autoEnabled = true;
});

describe("automatic eligible products", () => {
  it("discovers bounded aliases without changing a saved automatic mapping", async () => {
    const api = admin(product({ options: [{ name: "Upholstery Fabric" }, { name: "Fabric Color" }] }));
    expect((await ensureAutoProductConfig(api, "demo.myshopify.com", product().id))?.visualOptionName).toBe("Fabric Color");
    state.config = { id: "saved", autoConfigured: true, visualOptionName: "Old Fabric" };
    expect((await ensureAutoProductConfig(api, "demo.myshopify.com", product().id))?.visualOptionName).toBe("Old Fabric");
  });

  it("does not select a duplicate colour alias or a substring match", async () => {
    const api = admin(product({ options: [{ name: "Color" }, { name: "Colour" }] }));
    expect((await ensureAutoProductConfig(api, "demo.myshopify.com", product().id))?.visualOptionName).toBeNull();
    expect((await ensureAutoProductConfig(admin(product({ options: [{ name: "Fabric care" }] })), "demo.myshopify.com", product().id))?.visualOptionName).toBeNull();
  });
  it.each([
    ["Beds", "Egerie Bed", "bed"],
    ["Sofas", "3 seater sofa", "sofa"],
    ["Dining Tables", "Oak Round Dining Table", "table"],
    ["Chairs", "Soft Armchair", "chair"],
    ["Wardrobes", "Storage Wardrobe", "storage furniture"],
    ["Rugs", "Wool Rug", "rug"],
    ["Gift Cards", "£50 gift card", null],
    ["Bedding", "Cotton bed sheets", null],
    ["Mattresses", "Foam mattress", null],
    ["", "Ceramic vase", null],
  ])("classifies %s / %s", (type, title, expected) => {
    expect(autoFurnitureCategory(type, title)).toBe(expected);
  });

  it("only automatically enables active furniture with a product image", () => {
    expect(isAutoEligibleProduct({ productType: "Beds", title: "Bed", status: "ACTIVE", media: [{ id: "m" }] })).toBe(true);
    expect(isAutoEligibleProduct({ productType: "Beds", title: "Bed", status: "DRAFT", media: [{ id: "m" }] })).toBe(false);
    expect(isAutoEligibleProduct({ productType: "Beds", title: "Bed", status: "ACTIVE", media: [] })).toBe(false);
  });

  it("creates a ready config for newly encountered bed products with a valid reference", async () => {
    const api = admin();
    const config = await ensureAutoProductConfig(api, "demo.myshopify.com", product().id);
    expect(config).toMatchObject({
      enabled: true, autoConfigured: true, readiness: "ready",
      referenceMediaId: "gid://shopify/MediaImage/100", itemNoun: "bed", placement: "replace",
      visualOptionName: "Colour",
    });
    expect(api.graphql).toHaveBeenCalledOnce();
    expect(prisma.productPreviewConfig.upsert).toHaveBeenCalledOnce();
  });

  it("never overrides an existing manual OFF setting", async () => {
    state.config = { id: "manual", enabled: false, autoConfigured: false, readiness: "needs_attention" };
    const api = admin();
    expect(await ensureAutoProductConfig(api, "demo.myshopify.com", product().id)).toBe(state.config);
    expect(api.graphql).not.toHaveBeenCalled();
    expect(prisma.productPreviewConfig.upsert).not.toHaveBeenCalled();
  });

  it("honours selected-products mode, including already auto-configured products", async () => {
    state.autoEnabled = false;
    state.config = { id: "auto", enabled: true, autoConfigured: true };
    const api = admin();
    expect(await ensureAutoProductConfig(api, "demo.myshopify.com", product().id)).toBeNull();
    expect(api.graphql).not.toHaveBeenCalled();
    expect(prisma.productPreviewConfig.upsert).not.toHaveBeenCalled();
  });

  it("does not auto-configure non-furniture or products missing images", async () => {
    const api = admin(product({ productType: "Gift Cards", title: "Voucher" }));
    expect(await ensureAutoProductConfig(api, "demo.myshopify.com", product().id)).toBeNull();
    api.graphql.mockImplementation(async () => Response.json({ data: { product: product({ media: { nodes: [] } }) } }));
    expect(await ensureAutoProductConfig(api, "demo.myshopify.com", product().id)).toBeNull();
    expect(prisma.productPreviewConfig.upsert).not.toHaveBeenCalled();
  });

  it("refreshes a product's reference when Shopify photos change", async () => {
    state.config = {
      id: "auto", autoConfigured: true, enabled: true, readiness: "ready",
      referenceMediaId: "gid://shopify/MediaImage/deleted", visualOptionName: "Colour",
    };
    await ensureAutoProductConfig(admin(), "demo.myshopify.com", product().id);
    expect(prisma.productPreviewConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ referenceMediaId: "gid://shopify/MediaImage/100", autoConfigured: true }),
      }),
    );
  });

  it("returns no automatic config when a former active product becomes a draft", async () => {
    state.config = { id: "auto", autoConfigured: true, enabled: true, readiness: "ready" };
    expect(await ensureAutoProductConfig(admin(product({ status: "DRAFT" })), "demo.myshopify.com", product().id)).toBeNull();
  });
});
