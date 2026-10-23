# Room Assistant

The Room Assistant is an opt-in storefront chat for Shopify furniture merchants. It has three entry points: preview the current product through the existing Tryora flow, get grounded product recommendations from a room photo, and ask questions about the store's products and policies.

## Merchant controls

The assistant is disabled by default. Merchants enable and configure it from **Tryora > Room assistant**:

- page-type visibility, plus exact product and collection exclusions (exclusions win over page types). Exclusions control where the launcher appears. They do not hide products from search.
- greeting text, launcher label, position and colour.
- **Store notes**: up to 8,000 characters of merchant-written facts (delivery areas, lead times, showroom, warranty). Shoppers are quoted these notes, so they must be accurate.

Settings are stored in the existing `Appearance.copy` JSON object under the `assistant` key. The feature adds no Prisma models, migrations or startup database operations. Saving settings clears that shop's cached catalogue and store knowledge.

## Provider configuration

```env
OPENAI_API_KEY=...
OPENAI_ASSISTANT_MODEL=gpt-4.1-mini
OPENAI_ASSISTANT_PRIVACY_ACKNOWLEDGED=true
```

`OPENAI_ASSISTANT_MODEL` is optional and defaults to `gpt-4.1-mini`. The separate privacy acknowledgement is required because requests can send a normalised room image, bounded catalogue summaries and relevant policy sections to OpenAI. Every request uses the Responses API with `store: false`. The API key is used only on the server.

## What the assistant knows

| Source | What is used | How |
|---|---|---|
| Products | Every **active** product **published to the Online Store**, configured for Tryora or not: title, type, Shopify category, tags, vendor, description, collections, options and values, price range and currency, featured image | Per-shop search index, cached in memory |
| Variants | Exact options, price, compare-at price, `availableForSale`, image | Up to 20 per product in the index; **all** (up to 500) when read fresh with `get_product_details` |
| Attributes | Only these metafields: `custom.dimensions`, `width`, `depth`, `height`, `material`, `materials`, `fabric`, `care_instructions`, `assembly`, `warranty` | Read with the product. No other metafields are read |
| Policies | Shopify shop policies (refund, shipping, privacy, terms, contact, legal, subscription) in full | Split into sections; only relevant sections are retrieved |
| Pages | Published Online Store pages (FAQ, About, Delivery…) | Needs the `read_online_store_pages` scope; skipped without it (see *Staging*) |
| Merchant notes | The *Store notes* setting | Sectioned and retrieved like policies |
| Contact | Shop name, contact email and primary domain | Always available to `search_store_info` |
| Tryora previews | Which products have an enabled, ready preview configuration | Flag only; preview eligibility is verified per exact variant |

The assistant has **no** access to orders, customers, discounts, inventory quantities or shipping-rate calculations. It is told to say so and point shoppers to the store's contact details.

### Available to buy versus available for AI preview

Each recommendation card shows two separate facts, both checked in the same request:

- **Available to buy**: the exact variant's `availableForSale`, read fresh from Shopify.
- **AI room preview available**: shown only when the exact variant passes Tryora's strict preview path, which is the same `loadProviderSetting` → provider adapter → `resolveConfiguredPreview` → `resolvePreviewProduct` chain that `startPreview` uses (stock, frozen context, approved variant IDs, reference images).

Other preview states are `not_configured`, `unavailable`, `choose_options` (no exact variant was chosen) and `product_page`. `product_page` applies to Cloudlift or manual-mapping products: their image identity depends on the shopper's live product-page selection, so the assistant never claims a preview for them. Only cards with a verified preview link to `#tryora`. Every other card opens the normal product page.

## Search

`search_products` uses hybrid retrieval with no embeddings infrastructure:

1. **Vocabulary normalisation**, applied to the catalogue and to queries: sofa/couch/settee/loveseat, grey/gray, bed/bed frame/divan, nightstand/bedside table, cream/ivory/off-white, bouclé/boucle/teddy, faux/PU/vegan leather, king size/king, super king/California king, small double/4ft, small room/small space/space saving → compact, and more (`app/assistant/text.ts`). Some one-way widening is applied at half weight (grey also matches charcoal or slate, compact also matches loveseat or single).
2. **Field-weighted BM25** over title, type and category, collections, option values, tags, attributes and description.
3. **Constraints**: a named furniture kind is required ("green sofa" never returns a bed). Budget and availability are hard filters on known variants. Colour, size and material are soft: products that lack them are ranked lower and flagged with `notFoundOnProduct`. "King" never matches "Super King".
4. **Shopify search fallback**: when the index is cold or capped, the tool also queries Shopify (`products(query:, sortKey: RELEVANCE)`) and merges the results.
5. **Semantic layer**: the model rewrites the shopper's question into structured search fields and chooses among the verified results.

## Agent loop

- Read-only tools only: `search_products`, `get_product_details`, `search_store_info`, `list_collections`. Unknown tools and invalid arguments get an error result and are never executed.
- Up to **3 tool rounds** (the first round must call a tool), then one forced answer with `tool_choice: "none"`. At most 6 tool calls and 12 model-driven Shopify calls per request.
- 40 s total request budget, 30 s per model call, one retry for 429/5xx/connection errors when time allows.
- The final answer uses a strict JSON schema. Recommendations must name a `productRef` that a tool returned in this request (or a verified earlier recommendation). The `variantRef` must belong to that product in fresh data. Otherwise the recommendation is dropped and never substituted.
- Every recommended product is re-read fresh from Shopify before it is shown, so prices and stock are current even when the index is a few minutes old.

## Conversation continuity

The browser keeps chat state in tab memory, and room notes plus numbered recommendations in `sessionStorage`, so they survive page navigation within the tab:

- **Room notes** (colours, style, lighting, notes) returned after a photo analysis are sent back as structured, sanitised data on later messages. The photo is uploaded only for an explicit *Analyse* request. Shoppers can choose **Forget room**.
- **Shown recommendations** are sent back as `productRef`/`variantRef` pairs and listed for the model as "1., 2., 3.", so "the second one" resolves. The server validates the refs and re-reads them fresh before answering.

Nothing in this flow is written to the database. Room photos and chat content are never logged.

## Performance

The catalogue index is cached per shop for 5 minutes. A stale index (up to 30 minutes old) is served while it refreshes in the background. It is warmed when the storefront fetches the assistant config, so a first question rarely waits. If the index is still cold, a request waits up to 6 s and then falls back to live Shopify search. The index covers up to 1,000 products (50 pages of 20). Larger stores rely on the Shopify search fallback for the remainder.

Benchmark on a simulated Shopify Admin API (500-product catalogue, 25 Tryora-configured products, fixed per-call latency, model calls mocked so only Shopify and CPU time are measured):

| Path | Shopify calls / message | 60 ms latency | 200 ms latency |
|---|---|---|---|
| Previous implementation (every message) | 27 | ~1.7–1.8 s | ~5.5 s |
| New, cold cache, first message | 26 | ~2.1 s | ~5.8 s |
| New, warm cache, recommendation | 1 | ~80–95 ms | ~230 ms |
| New, warm cache, verified-preview recommendation | 2 | ~140–155 ms | ~430 ms |
| Background warm-up (off the shopper path) | 25 | ~1.9 s | ~5.3 s |

Model latency dominates real requests. Each request makes 2 Responses API calls when one tool round is enough, and up to 4 at most. The previous implementation always made exactly 2.

## Logging

`app/assistant/log.server.ts` writes one JSON line per event: `assistant_request`, `openai_failure`, `shopify_failure`, `tool_validation_failure`, `model_parse_failure`, `timeout`, `rate_limited`, `catalogue_loaded` and `recommendation_dropped`. Fields are allowlisted (shop domain, stage, status, durations, counts, token usage, error class). Message text, photos, visitor IDs, emails, upstream error messages and API keys are never written.

## Rate limits

- 20 messages per visitor and 200 per shop per 10 minutes (`guardAssistant`), plus at most 8 concurrent assistant requests per shop.
- These counters, the catalogue cache and the knowledge cache are **in process memory**. With several app instances each one keeps its own counters and caches: limits become per instance, and a settings save clears the cache only on the instance that handled it (others refresh within 5 minutes). A shared limiter needs Redis or a database table. Neither exists today, and adding a table needs a migration, so this is left for a planned infrastructure change.
- Assistant messages never reserve or consume preview credits. Credits are used only by the existing preview delivery flow.

## Staging checklist (not yet verified against a live store)

1. Run each new Admin query (`TryoraAssistantCatalogue`, `TryoraAssistantProductDetail`, `TryoraAssistantStoreInfo`, `TryoraAssistantPages`) against a development store on API version 2026-07 and check query cost. The tests use a simulated Admin API.
2. Decide whether to request `read_online_store_pages`. Until it is added to `shopify.app.toml` and merchants re-approve scopes, FAQ and About pages are skipped. Policies and store notes still work.
3. Confirm request time through the Shopify app proxy for a 3-round answer. The server budget is 40 s; the browser waits 55 s.
4. Check the `custom.*` metafield allowlist against real merchant catalogues.
5. Enable for one merchant, verify answers, recommendation badges and preview links, then widen.

## Release verification

Run from the repository root:

```sh
npm test
npm run typecheck
npm run build
git diff --check
```

The storefront bundle at `shopify-app/extensions/tryora-theme/assets/tryora.js` is generated by `npm run build` and must not be edited manually.
