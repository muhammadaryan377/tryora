import { describe, expect, it, vi } from "vitest";
import { sampleMediaIds, savedFabricSampleFiles } from "../app/customization/fabric-sample-files.server";
import { findUploadedMedia } from "../app/customization/fabric-media.server";

const fileId = "gid://shopify/MediaImage/767";
const marker = "Tryora fabric sample 98765432-9876-4987-a987-987654321012";

describe("isolated Shopify Files for Tryora fabric samples", () => {
  it("resolves merchant-saved swatches without attaching them to product media", async () => {
    const admin = { graphql: vi.fn(async (query: string, init: any) => {
      expect(query).toContain("TryoraSavedFabricSamples");
      expect(query).not.toContain("productUpdate");
      expect(init.variables.ids).toEqual([fileId]);
      return Response.json({ data: { nodes: [
        { id: fileId, alt: marker, fileStatus: "READY", image: { url: "https://cdn.shopify.com/files/swatch.jpg" } },
      ] } });
    }) };
    expect(await savedFabricSampleFiles(admin, [fileId], new Set())).toEqual([
      { id: fileId, alt: marker, image: { url: "https://cdn.shopify.com/files/swatch.jpg" } },
    ]);
    expect(admin.graphql).toHaveBeenCalledTimes(1);
  });

  it("never accepts arbitrary product photos, nonready assets or client image URLs as samples", async () => {
    const admin = { graphql: vi.fn(async () => Response.json({ data: { nodes: [
      { id: fileId, alt: "Full bed photograph", fileStatus: "READY", image: { url: "https://cdn.shopify.com/files/bed.jpg" } },
    ] } })) };
    expect(await savedFabricSampleFiles(admin, [fileId, "https://attacker.invalid/photo"], new Set())).toEqual([]);
    expect(await savedFabricSampleFiles(admin, [fileId], new Set([fileId]))).toEqual([]);
    expect(admin.graphql).toHaveBeenCalledTimes(1);
  });

  it("polls a Shopify File by its verified ID and never queries product gallery media", async () => {
    const admin = { graphql: vi.fn(async (query: string, init: any) => {
      expect(query).toContain("TryoraFabricFileUploadStatus");
      expect(query).not.toContain("product(id:");
      expect(init.variables.id).toBe(fileId);
      return Response.json({ data: { node: { id: fileId, alt: marker, fileStatus: "READY",
        image: { url: "https://cdn.shopify.com/files/swatch.jpg" } } } });
    }) };
    await expect(findUploadedMedia(admin, "gid://shopify/Product/123", marker, fileId)).resolves.toEqual({
      id: fileId, alt: marker, url: "https://cdn.shopify.com/files/swatch.jpg",
    });
    await expect(findUploadedMedia(admin, "gid://shopify/Product/123", "forged", fileId)).rejects.toThrow("Invalid isolated sample");
    expect(admin.graphql).toHaveBeenCalledTimes(1);
  });

  it("gets only saved sample IDs, never full-product furniture reference IDs", () => {
    const draft = { fabrics: [{ textureMediaId: fileId, colours: [
      { swatchMediaId: fileId }, { swatchMediaId: null },
    ] }, { textureMediaId: "https://attacker.invalid/a.jpg", colours: [
      { swatchMediaId: "gid://shopify/MediaImage/900" },
    ] }] };
    expect(sampleMediaIds(draft)).toEqual([fileId, "gid://shopify/MediaImage/900"]);
  });
});
