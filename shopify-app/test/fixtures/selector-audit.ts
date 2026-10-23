import type { NativeOption, NativeVariant } from "../../app/core/customization";

// Synthetic Shopify payloads: these are not exports from the Avelor store.
const option = (name: string, ...values: string[]): NativeOption => ({ name, optionValues: values.map((name) => ({ name })) });
const variant = (id: string, options: Record<string, string>, photo = true): NativeVariant => ({
  id, availableForSale: true, selectedOptions: Object.entries(options).map(([name, value]) => ({ name, value })),
  image: photo ? { url: `https://cdn.shopify.com/${id}.jpg` } : null,
});
const fabrics = option("Fabric", "Plush Velvet", "Teddy Boucle");
const colours = option("Colour", "Cream", "Grey");
const sizes = option("Size", "Double", "King");
export const selectorAuditFixtures = {
  native: { options: [fabrics, colours], visualOptionName: "Fabric", variants: [
    variant("velvet-cream", { Fabric: "Plush Velvet", Colour: "Cream" }),
    variant("boucle-grey", { Fabric: "Teddy Boucle", Colour: "Grey" }),
  ] },
  fabricOnly: { options: [fabrics], visualOptionName: "Fabric", variants: [
    variant("velvet", { Fabric: "Plush Velvet" }), variant("boucle", { Fabric: "Teddy Boucle" }),
  ] },
  externalColours: { options: [sizes], visualOptionName: null, variants: [
    variant("double", { Size: "Double" }), variant("king", { Size: "King" }),
  ], externalOptions: { Fabric: ["Plush Velvet"], Colour: ["Cream", "Grey"] },
  metafields: [{ namespace: "custom", key: "fabric_colours", jsonValue: { "Plush Velvet": ["Cream", "Grey"] } }] },
  sizesAndFabrics: { options: [sizes, fabrics], visualOptionName: "Fabric", variants: [
    variant("double-velvet", { Size: "Double", Fabric: "Plush Velvet" }),
    variant("king-velvet", { Size: "King", Fabric: "Plush Velvet" }),
    variant("king-boucle", { Size: "King", Fabric: "Teddy Boucle" }),
  ] },
  missingPhoto: { options: [fabrics, colours], visualOptionName: "Fabric", variants: [
    variant("no-photo", { Fabric: "Plush Velvet", Colour: "Cream" }, false),
  ] },
  singleStyle: { options: [option("Title", "Default Title")], visualOptionName: null,
    variants: [variant("single", { Title: "Default Title" })] },
};
