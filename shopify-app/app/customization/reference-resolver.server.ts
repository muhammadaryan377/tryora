import { PREVIEW_MEDIA_QUERY, PREVIEW_PRODUCT_QUERY, type AdminGraphql } from "../preview-product.server";
import { TryoraError } from "../core/index";
import type { NativeVariant } from "../core/customization";

export async function nativeSnapshot(admin: AdminGraphql, productId: string, includeMedia = true, prefetched?: { product: any; variants: NativeVariant[] }) {
  let product: any = prefetched?.product;
  if (product?.id && product.id !== productId) throw new TryoraError("NOT_FOUND");
  const variants: NativeVariant[] = [...(prefetched?.variants ?? [])], media: { id: string; alt?: string | null; image?: { url: string } | null }[] = [];
  const deadline = Date.now() + 20_000;
  async function pages(query: string, field: "variants" | "media") {
    let after: string | null = null;
    for (let count = 0; count < 12; count++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new TryoraError("PROVIDER_UNAVAILABLE");
      let timer: ReturnType<typeof setTimeout> | undefined;
      let response: Response, json: any;
      try {
        [response, json] = await Promise.race([
          (async () => { const r = await admin.graphql(query, { variables: { id: productId, after } }); return [r, await r.json()] as const; })(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new TryoraError("PROVIDER_UNAVAILABLE")), remaining); }),
        ]);
      } finally { clearTimeout(timer); }
      const p = json.data?.product;
      if (!response.ok || json.errors?.length || !p || (p.id && p.id !== productId)) throw new TryoraError("NOT_FOUND");
      if (field === "variants") product = p;
      const page = p[field];
      if (!page || !Array.isArray(page.nodes)) throw new TryoraError("PROVIDER_UNAVAILABLE");
      if (field === "variants") variants.push(...page.nodes); else media.push(...page.nodes.filter((m: any) => m?.id && m.image?.url));
      if (!page.pageInfo?.hasNextPage) return;
      const cursor = page.pageInfo.endCursor;
      if (!cursor || cursor === after) throw new TryoraError("PROVIDER_UNAVAILABLE");
      after = cursor;
    }
    throw new TryoraError("PROVIDER_UNAVAILABLE");
  }
  if (!prefetched) await pages(PREVIEW_PRODUCT_QUERY, "variants");
  const ids = new Set<string>();
  for (const v of variants) {
    if (!v || typeof v.id !== "string" || ids.has(v.id) || typeof v.availableForSale !== "boolean" ||
      !Array.isArray(v.selectedOptions) || !v.selectedOptions.length || v.selectedOptions.length > 32 ||
      v.selectedOptions.some((o) => !o || typeof o.name !== "string" || typeof o.value !== "string") ||
      new Set(v.selectedOptions.map((o) => o.name)).size !== v.selectedOptions.length) throw new TryoraError("PROVIDER_UNAVAILABLE");
    ids.add(v.id);
  }
  if (includeMedia) await pages(PREVIEW_MEDIA_QUERY, "media");
  return { product, variants, media };
}

export function nativeOptionCatalog(product: any) {
  return (product.options ?? []).filter((o: any) => typeof o.id === "string").map((o: any) => ({
    id: o.id as string, name: o.name as string,
    values: (o.optionValues ?? []).filter((v: any) => typeof v.id === "string").map((v: any) => ({ id: v.id as string, name: v.name as string })),
  }));
}
