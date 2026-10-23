import { beforeEach, describe, expect, it, vi } from "vitest";
import { previewOptionStatus } from "../app/preview-option-status";

const state = vi.hoisted(() => ({ configs: [] as any[] }));
vi.mock("../app/db.server", () => ({ default: {
  productPreviewConfig: { findMany: vi.fn(async () => state.configs) },
  shop: { findUnique: vi.fn(async () => ({ autoEnableProducts: true })) },
} }));
import { productRows, type ShopProduct } from "../app/products.server";

const options = [{ name: "Fabric", values: ["Velvet", "Boucle"], swatches: [] },
  { name: "Colour", values: ["Cream"], swatches: [] }];
beforeEach(() => { state.configs = []; });

describe("admin preview mapping diagnostics", () => {
  it.each(["Fabric", "Colour"])("recognizes the exact native %s mapping", (name) => {
    const result = previewOptionStatus(options, name);
    expect(result.state).toBe("mapped");
    expect(result.label).toBe(name === "Fabric" ? "Fabric (2 values)" : "Colour (1 value)");
    expect(result.warning).toBeNull();
  });

  it("does not call absent native customization data a single style", () => {
    expect(previewOptionStatus([], null)).toMatchObject({ state: "missing", label: "No preview option found or configured" });
    expect(previewOptionStatus(options, null, { visualOptionName: null, autoConfigured: true }).state).toBe("missing");
  });

  it("describes saved no-selector settings without inferring product inventory or changing them", () => {
    const saved = { visualOptionName: null, autoConfigured: false };
    expect(previewOptionStatus(options, null, saved)).toEqual({
      state: "configured_without_selector", label: "Configured without selector", warning: null,
    });
    expect(saved).toEqual({ visualOptionName: null, autoConfigured: false });
  });

  it("flags stale mappings and offers correction without choosing a replacement", () => {
    const result = previewOptionStatus(options, "Old Colour", { visualOptionName: "Old Colour", autoConfigured: false });
    expect(result.state).toBe("stale");
    expect(result.label).toBe("Unavailable option: Old Colour");
    expect(result.warning).toContain("Open settings");
    expect(previewOptionStatus(options, "colour").state).toBe("stale");
  });

  it("does not mistake a renamed option for a valid saved mapping", () => {
    expect(previewOptionStatus([{ name: "Upholstery", values: ["Cream", "Grey"] }], "Fabric").state).toBe("stale");
  });

  it("preserves manual OFF, saved null and stale settings even with automatic products enabled", async () => {
    const product: ShopProduct = { id: "bed", title: "Bed", status: "ACTIVE", productType: "Beds", options,
      media: [{ id: "photo", url: "https://cdn.shopify.com/bed.jpg" }] };
    for (const name of [null, "Old Colour"]) {
      state.configs = [{ productId: "bed", autoConfigured: false, enabled: false, visualOptionName: name }];
      const original = JSON.stringify(state.configs);
      const [row] = await productRows("test.myshopify.com", [product]);
      expect(row?.enabled).toBe(false);
      expect(row?.readiness).toBe("off");
      expect(row?.visualOptionName).toBe(name);
      expect(row?.previewOptionStatus.state).toBe(name === null ? "configured_without_selector" : "stale");
      expect(JSON.stringify(state.configs)).toBe(original);
    }
  });

  it("reports missing automatic discovery separately from a valid native mapping", async () => {
    const base: ShopProduct = { id: "bed", title: "Bed", status: "ACTIVE", productType: "Beds", options: [],
      media: [{ id: "photo", url: "https://cdn.shopify.com/bed.jpg" }] };
    expect((await productRows("test.myshopify.com", [base]))[0]?.previewOptionStatus.state).toBe("missing");
    expect((await productRows("test.myshopify.com", [{ ...base, options }]))[0]?.previewOptionStatus.state).toBe("mapped");
  });
});
