/**
 * Live-store verification for the Room Assistant catalogue fix. Read-only. Skipped unless TRYORA_VERIFY_SHOP is set.
 *
 *   TRYORA_VERIFY_SHOP=test-sofa-site.myshopify.com \
 *   TRYORA_VERIFY_TOKEN=<Admin API token with read_products> \
 *   [TRYORA_VERIFY_HANDLE=<product handle>] [TRYORA_VERIFY_BEDS="Title A|Title B"] \
 *   [TRYORA_VERIFY_CHAT=1 OPENAI_API_KEY=... OPENAI_ASSISTANT_MODEL=...] \
 *   [TRYORA_VERIFY_REPORT=<path to write a JSON report>] \
 *   npx vitest run test/assistant-live-store.verify.test.ts
 *
 * It runs this commit's real code (catalogue index, live search, counting, product detail, merchant diagnostics and,
 * optionally, full chatbot turns with the real model) against the real Admin API, and records the query cost
 * Shopify reports for every request. Nothing is written to Shopify; no database is used (preview eligibility is
 * therefore reported as "not configured").
 */
import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("../app/db.server", () => ({
  default: {
    appearance: { findFirst: vi.fn(async () => null) },
    productPreviewConfig: { findMany: vi.fn(async () => []) },
    customizationConfig: { findMany: vi.fn(async () => []) },
  },
}));

import { countCatalogue, getCatalogue, getProductDetails, PRODUCT_COUNT_QUERY, resetAssistantCatalogueCache, searchCatalogue, ShopifyBudget } from "../app/assistant/catalogue.server";
import { runAssistantDiagnostics } from "../app/assistant/diagnostics.server";
import { setAssistantLogSink } from "../app/assistant/log.server";
import { answerRoomAssistant } from "../app/room-assistant.server";
import { DEFAULT_ROOM_ASSISTANT_SETTINGS } from "../app/room-assistant-settings";

const SHOP = process.env.TRYORA_VERIFY_SHOP ?? "";
const TOKEN = process.env.TRYORA_VERIFY_TOKEN ?? "";
const HANDLE = process.env.TRYORA_VERIFY_HANDLE ?? "egerie-curved-headboard-beige-boucle-bed";
const EXPECTED_BEDS = (process.env.TRYORA_VERIFY_BEDS ?? "Chelsea Luxe Bed|Thames Bed Frame|Egerie Curved Headboard Beige Boucle Bed|Monaco Panelled Bed").split("|");
const API_VERSION = "2026-07"; // matches ApiVersion.July26 in app/shopify.server.ts
// Only for dry-running this file against a local stand-in; real verification uses the store's own endpoint.
const ENDPOINT = process.env.TRYORA_VERIFY_ENDPOINT ?? `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;

interface CostRecord { operation: string; requested: number | null; actual: number | null; errors: string[] }
const costs: CostRecord[] = [];
const logs: string[] = [];
const report: Record<string, unknown> = { shop: SHOP, apiVersion: API_VERSION, startedAt: new Date().toISOString() };

/** AdminGraphql over the real Admin API, recording Shopify's reported cost for every request. */
const admin = {
  async graphql(query: string, options?: { variables?: Record<string, unknown> }) {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
      body: JSON.stringify({ query, variables: options?.variables ?? {} }),
    });
    const text = await response.text();
    let json: any = {};
    try { json = JSON.parse(text); } catch { /* recorded below */ }
    costs.push({
      operation: query.match(/query (\w+)/)?.[1] ?? "anonymous",
      requested: json?.extensions?.cost?.requestedQueryCost ?? null,
      actual: json?.extensions?.cost?.actualQueryCost ?? null,
      errors: (json?.errors ?? []).map((error: any) => error?.extensions?.code ?? "ERROR"),
    });
    return new Response(text, { status: response.status, headers: { "Content-Type": "application/json" } });
  },
};

const finish = () => {
  report.finishedAt = new Date().toISOString();
  report.queryCosts = costs;
  report.maxRequestedCost = Math.max(0, ...costs.map((cost) => cost.requested ?? 0));
  report.assistantLogs = logs;
  if (process.env.TRYORA_VERIFY_REPORT) writeFileSync(process.env.TRYORA_VERIFY_REPORT, JSON.stringify(report, null, 2));
};

describe.skipIf(!SHOP || !TOKEN)(`Room Assistant against ${SHOP || "a live store"}`, () => {
  setAssistantLogSink((line) => logs.push(line));

  it("merchant diagnostics: scopes, counts, catalogue query, search and the viewed product", async () => {
    const diagnostics = await runAssistantDiagnostics(admin, SHOP, { search: "bed", handle: HANDLE });
    report.diagnostics = diagnostics.checks;
    expect(diagnostics.checks.scopes.ok, diagnostics.checks.scopes.detail).toBe(true);
    expect(diagnostics.checks.catalogue.ok, diagnostics.checks.catalogue.detail).toBe(true);
    expect(diagnostics.checks.search.ok, diagnostics.checks.search.detail).toBe(true);
    expect(diagnostics.checks.product.ok, diagnostics.checks.product.detail).toBe(true);
  }, 60_000);

  it("loads the full catalogue index without Shopify errors and finds every expected bed", async () => {
    resetAssistantCatalogueCache();
    const started = Date.now();
    const { snapshot } = await getCatalogue(admin, SHOP, 120_000);
    expect(snapshot, "catalogue failed to load; see report.queryCosts").not.toBeNull();
    const beds = searchCatalogue(snapshot!, { query: "bed", colour: null, size: null, material: null, style: null, minPrice: null, maxPrice: null, availableOnly: false, limit: 10 });
    const counted = countCatalogue(snapshot!, { query: "bed", colour: null, material: null });
    report.catalogue = {
      products: snapshot!.products.length,
      complete: snapshot!.complete,
      pages: snapshot!.shopifyCalls,
      loadMs: Date.now() - started,
      bedSearch: beds.map((match) => ({ title: match.product.title, type: match.product.productType, published: true, sampleAvailable: match.product.variants.filter((variant) => variant.available).length, sampleSize: match.product.variants.length, variantsComplete: match.product.variantsComplete })),
      bedCountFromIndex: counted.length,
      bedsCounted: counted.map((product) => product.title),
    };
    expect(costs.filter((cost) => cost.operation === "TryoraAssistantCatalogue" && cost.errors.length)).toEqual([]);
    for (const title of EXPECTED_BEDS) expect(counted.map((product) => product.title), `${title} missing from the assistant's index`).toContain(title);
  }, 180_000);

  it("counts beds with Shopify productsCount and matches the index", async () => {
    const response = await admin.graphql(PRODUCT_COUNT_QUERY, { variables: { query: "status:active AND (bed OR beds)" } });
    const json: any = await response.json();
    report.productsCount = json?.data?.productsCount ?? json?.errors;
    expect(json.errors).toBeUndefined();
    expect(json.data.productsCount.count).toBeGreaterThanOrEqual(EXPECTED_BEDS.length);
  }, 60_000);

  it("reads exact variant availability for the viewed product", async () => {
    const { snapshot } = await getCatalogue(admin, SHOP, 120_000);
    const ref = snapshot!.products.find((product) => product.handle === HANDLE)?.ref;
    expect(ref, `${HANDLE} not in the assistant's index`).toBeTruthy();
    const details = await getProductDetails(admin, [ref!], new ShopifyBudget(5));
    const product = details.get(ref!)!;
    report.viewedProduct = {
      title: product.title, type: product.productType, category: product.category, price: [product.minPrice, product.maxPrice, product.currencyCode],
      variants: product.variants.map((variant) => ({ options: variant.options, price: variant.price, availableForSale: variant.available })),
      allVariantsLoaded: product.variantsComplete,
    };
    expect(product.variants.length).toBeGreaterThan(0);
  }, 60_000);

  it.runIf(process.env.TRYORA_VERIFY_CHAT === "1" && !!process.env.OPENAI_API_KEY)("chatbot: real model answers from real products on the viewed product's page", async () => {
    const { snapshot } = await getCatalogue(admin, SHOP, 120_000);
    const current = snapshot!.products.find((product) => product.handle === HANDLE)!;
    const env = { ...process.env, OPENAI_ASSISTANT_PRIVACY_ACKNOWLEDGED: "true" } as NodeJS.ProcessEnv;
    const settings = { ...DEFAULT_ROOM_ASSISTANT_SETTINGS, enabled: true };
    const turn = (history: { role: "user" | "assistant"; content: string }[]) =>
      answerRoomAssistant({ admin, shopId: SHOP, history, currentProductId: current.id, env, settings });
    const absence = /(?:does\s+not|doesn['’]t|do\s+not|don['’]t)\s+(?:currently\s+)?(?:have|sell)\s+any\s+beds|no\s+beds/i;

    const beds = await turn([{ role: "user", content: "Do you have any beds?" }]);
    const count = await turn([{ role: "user", content: "How many beds do you sell?" }]);
    const correction = await turn([
      { role: "user", content: "Do you have beds?" },
      { role: "assistant", content: "This store currently does not have any beds available for sale." },
      { role: "user", content: "But I'm looking at the Egerie bed right now?" },
    ]);
    report.chat = [
      { question: "Do you have any beds?", message: beds.message, cards: beds.recommendations.map((card) => [card.title, card.purchaseAvailable]) },
      { question: "How many beds do you sell?", message: count.message },
      { question: "Correction after a wrong answer", message: correction.message },
    ];
    for (const reply of [beds, count, correction]) expect(reply.message).not.toMatch(absence);
    expect(`${beds.message} ${beds.recommendations.map((card) => card.title).join(" ")}`).toMatch(new RegExp(EXPECTED_BEDS.map((title) => title.split(" ")[0]).join("|"), "i"));
    expect(count.message).toMatch(new RegExp(`\\b${EXPECTED_BEDS.length}\\b|${["zero", "one", "two", "three", "four", "five", "six"][EXPECTED_BEDS.length] ?? "x"}`, "i"));
    expect(correction.message).toMatch(/Egerie/i);
  }, 240_000);

  it("writes the report", () => { finish(); expect(costs.length).toBeGreaterThan(0); });
});
