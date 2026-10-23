/**
 * Read-only catalogue diagnostics for merchants (Tryora › Room assistant › Check catalogue connection).
 * Runs the assistant's own Shopify queries against the merchant's store and reports what the assistant can see,
 * with Shopify's error codes and reported query cost. Nothing is written and no shopper data is involved.
 */
import type { AdminGraphql } from "../preview-product.server";
import {
  CATALOGUE_QUERY,
  catalogueCacheInfo,
  publishedToOnlineStore,
  liveSearch,
  parseProduct,
  PRODUCT_COUNT_QUERY,
  shopifyErrorCode,
  ShopifyBudget,
  type ProductQuery,
} from "./catalogue.server";

export interface DiagnosticCheck { ok: boolean; detail: string; code?: string }

async function raw(admin: AdminGraphql, query: string, variables: Record<string, unknown>) {
  try {
    const response = await admin.graphql(query, { variables });
    const json: any = await response.json();
    return { json, status: response.status, error: json?.errors?.length ? shopifyErrorCode(json) ?? "GRAPHQL_ERROR" : !response.ok ? `HTTP_${response.status}` : undefined };
  } catch (error: any) {
    const body = error?.body ?? error?.response?.body;
    return { json: body ?? null, status: 0, error: shopifyErrorCode(body) ?? String(error?.name ?? "REQUEST_FAILED") };
  }
}

const cost = (json: any) => {
  const value = json?.extensions?.cost;
  return value ? `requested ${value.requestedQueryCost ?? "?"}, actual ${value.actualQueryCost ?? "?"}` : "not reported";
};

function publication(node: { onlineStoreUrl?: string | null; publishedAt?: string | null }) {
  if (node.onlineStoreUrl) return "published to the Online Store";
  if (publishedToOnlineStore(node)) return `published to the Online Store at ${node.publishedAt} (no onlineStoreUrl, as on password-protected stores)`;
  if (node.publishedAt) return `scheduled for the Online Store at ${node.publishedAt} (the assistant ignores it until then)`;
  return "NOT published to the Online Store (the assistant ignores it)";
}

const searchQuery = (query: string): ProductQuery => ({
  query, colour: null, size: null, material: null, style: null, minPrice: null, maxPrice: null, availableOnly: false, limit: 10,
});

export async function runAssistantDiagnostics(admin: AdminGraphql, shop: string, input: { search: string; handle: string }) {
  const checks: Record<string, DiagnosticCheck> = {};

  const scopes = await raw(admin, `#graphql
    query TryoraAssistantScopes { currentAppInstallation { accessScopes { handle } } }`, {});
  const granted: string[] = scopes.json?.data?.currentAppInstallation?.accessScopes?.map((scope: any) => scope.handle) ?? [];
  checks.scopes = {
    ok: !scopes.error && (granted.includes("read_products") || granted.includes("write_products")),
    detail: scopes.error ? "Could not read access scopes." : `Granted: ${granted.join(", ") || "none"}. Online Store pages ${granted.includes("read_online_store_pages") ? "are" : "are not"} readable.`,
    code: scopes.error,
  };

  const active = await raw(admin, PRODUCT_COUNT_QUERY, { query: "status:active" });
  const all = await raw(admin, PRODUCT_COUNT_QUERY, { query: null });
  checks.counts = {
    ok: !active.error && !all.error,
    detail: active.error || all.error ? "Shopify product counts are unavailable."
      : `${active.json.data.productsCount.count} active of ${all.json.data.productsCount.count} products (${active.json.data.productsCount.precision}).`,
    code: active.error ?? all.error,
  };

  const page = await raw(admin, CATALOGUE_QUERY, { after: null, query: "status:active", sortKey: "ID" });
  const nodes: any[] = page.json?.data?.products?.nodes ?? [];
  const usable = nodes.filter((node) => parseProduct(node, node.variants?.nodes ?? [], false));
  // Password-protected stores return no onlineStoreUrl even for published products; publication uses publishedAt.
  const withoutUrl = nodes.filter((node) => !node.onlineStoreUrl && publishedToOnlineStore(node)).length;
  checks.catalogue = {
    ok: !page.error && nodes.length > 0,
    detail: page.error
      ? `The assistant's catalogue query failed (cost ${cost(page.json)}). The assistant cannot see products until this is fixed.`
      : `First page returned ${nodes.length} active products; ${usable.length} are published to the Online Store and usable.${withoutUrl ? ` ${withoutUrl} have no onlineStoreUrl but a publishedAt date (expected while the store is password-protected); they are included.` : ""} Query cost ${cost(page.json)}.`,
    code: page.error,
  };

  try {
    const found = await liveSearch(admin, shop, searchQuery(input.search), new ShopifyBudget(1));
    checks.search = {
      ok: found.products.length > 0,
      detail: found.products.length
        ? `Search "${input.search}" found: ${found.products.slice(0, 10).map((product) => product.title).join("; ")}.`
        : `Search "${input.search}" found no published products.`,
    };
  } catch {
    checks.search = { ok: false, detail: `Search "${input.search}" failed; see the catalogue check.`, code: "SEARCH_FAILED" };
  }

  if (input.handle) {
    const lookup = await raw(admin, CATALOGUE_QUERY, { after: null, query: `handle:${input.handle.replace(/[^a-z0-9-]/gi, "")}`, sortKey: "ID" });
    const node = lookup.json?.data?.products?.nodes?.[0];
    if (lookup.error) checks.product = { ok: false, detail: "Product lookup failed.", code: lookup.error };
    else if (!node) checks.product = { ok: false, detail: `No product with handle "${input.handle}".` };
    else {
      const sample = node.variants?.nodes ?? [];
      const available = sample.filter((variant: any) => variant.availableForSale).length;
      const usableProduct = parseProduct(node, sample, false);
      checks.product = {
        ok: !!usableProduct,
        detail: `"${node.title}" — status ${node.status}, ${publication(node)}, link /products/${node.handle}, type "${node.productType || "none"}", ${node.variantsCount?.count ?? sample.length} variants (${available} of the first ${sample.length} available to buy).`,
      };
    }
  }

  const cached = catalogueCacheInfo(shop);
  checks.cache = {
    ok: true,
    detail: cached ? `Cached index: ${cached.products} products, ${cached.complete ? "complete" : "partial"}, ${cached.ageSeconds}s old.` : "No cached index yet (it loads when a shopper opens the assistant).",
  };

  return { shop, checkedAt: new Date().toISOString(), checks };
}
