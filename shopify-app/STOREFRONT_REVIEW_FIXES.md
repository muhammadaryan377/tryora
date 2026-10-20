# Storefront review fixes

Branch: `fix/storefront-preview-reliability`. The imported workspace is preserved in the `main` baseline commit. Nothing has been deployed and no production services have been modified.

## Changes

| Review finding | Change | Regression coverage |
| --- | --- | --- |
| Missing product photos and description | Load paginated Shopify variants, match the selected value and frozen options, resolve approved media belonging to the product, and download the variant photo plus approved references in memory. Pass title/description to the provider. | `product.test.ts`, `storefront.test.ts` |
| Stranded credit/quota reservations | Expiry aborts work, clears image bytes and transitions the persistent job to `EXPIRED`. A periodic sweep and configuration/start checks recover stale reservations after restarts. The engine uses creation time for the maximum reservation lifetime. | Core reservation deadline tests; storefront lifecycle tests; PostgreSQL reservation tests |
| Optional/bypassable photo checks | Decode and normalise every submitted room photo and run server-side room analysis before reserving. Browser check failures require a new upload. Analysis receives the configured angle, placement, setting and item noun. | `images.test.ts`, `popup.test.ts`, `storefront.test.ts` |
| Unbounded generation | A three-minute deadline covers reference downloads, generation and result checks. Each call receives cancellation; late results and ignored terminal transitions cannot become ready. Analysis has a separate 30-second deadline. | Hung-provider and cancelled-job tests; abort helper tests |
| Process-local results on multiple instances | Server-generated job IDs identify the owning worker. Configured workers forward polling and image cleanup over an authenticated internal endpoint, with operator-controlled origins and request deadlines. Image bytes remain transient. | `worker.test.ts` |
| Cosmetic result checking | Fully decode/re-encode output and require the provider's `checkResult` to accept product/colour fidelity, placement and room preservation. Rejected or invalid outputs do not consume credit. | Result rejection, corrupt image and browser decode tests |
| Missing server-side eligibility checks | Require enabled/ready configuration, a valid available option, matching frozen options, eligible variant IDs and available merchant visual choices. Deleted approved media fails safely. Single-colour products resolve their actual value. | `product.test.ts`, `storefront.test.ts` |
| Unreliable acknowledgement and duplicate analytics | Decode before publishing the browser result. Retry transient acknowledgement errors until token expiry. Use a deterministic event ID with database upsert so retries cannot duplicate delivery analytics. Creation retries reuse one idempotency key. | Client reliability/popup tests; concurrent acknowledgement tests in memory and PostgreSQL |
| Consent errors ignored | Inspect HTTP, GraphQL and mutation user errors. Failed consent is recorded as a failed lead delivery while the preview flow continues. Successful lead analytics are emitted only after successful delivery. | Lead delivery tests |
| Misleading privacy comments/raw stored errors | Document retained metadata/customer references accurately. Persist fixed error codes instead of raw Shopify exception text. Strip image metadata when normalising. Require confirmed zero retention and cancellation support before provider use. | Safe error tests; EXIF tests; provider capability test |
| Missing costs/request IDs | Save request ID and accumulated completed costs on jobs. Add `ProviderUsage` for photo analysis, generation, result checks and failed-attempt cost metadata, without prompts or images. Unknown costs are null, not zero. | Lifecycle cost tests; failed-attempt tests; PostgreSQL schema test |
| Image/token lifetime mismatch | Keep ready bytes until the delivery token expires, and expire both at the same deadline. Reject acknowledgements exactly at expiry. Never return an expired ready result. | Core exact-deadline tests; storefront expiry tests |
| Truncated variant availability | Paginate variant availability in storefront configuration as well as generation validation. | Later-page swatch availability test |

The shared engine is edited in `packages/core/src` and copied into `app/core` with `node scripts/sync-core.mjs`. The storefront source is rebuilt into the theme extension asset. Existing mock mode, merchant settings, lead timing/skipping, trial credits and credit-on-acknowledgement behavior remain.

## Validation

The root commands now cover the app as well as the workspaces:

- `npm test`: 58 core tests and 38 app/browser/persistence tests pass when the isolated database is supplied.
- `npm run typecheck`: core, storefront and Shopify app pass.
- `npm run build`: storefront theme bundle and Shopify client/server builds pass.
- Shopify AI Toolkit schema validation: product, media and configuration queries validate against the configured Admin API version `2026-07`. Existing `ProductVariant.image` selections produce deprecation notices.

For persistence validation, a separate PostgreSQL cluster was created under the ignored `.test-postgres/` directory and bound only to `127.0.0.1:55439`. The original baseline schema was installed into `tryora_test_review`; `prisma/changes/provider-usage.sql` was then applied successfully. Integration tests exercise the real Prisma backend, PostgreSQL advisory locking, ledger/quota persistence, concurrent analytics upserts and the new usage table. This did not use the application's database URL. The test server is stopped after verification.

Database tests are opt-in through `TRYORA_TEST_DATABASE_URL`. They refuse non-local hosts and databases whose names do not start with `tryora_test_`; without that variable the three database tests are skipped. All other tests run without a database or external API.

## Requirements before a later release

1. Apply the additive `prisma/changes/provider-usage.sql` through the installation's schema-change process, or incorporate the updated Prisma schema into that process. The repository uses schema push and has no migration history; this change does not invent an incomplete Prisma migration history. Generate Prisma Client after installing dependencies. No production schema change has been performed.
2. The default configuration supports one app process. For multiple processes, give every worker a unique alphanumeric `TRYORA_WORKER_ID`, configure the same `TRYORA_WORKER_ORIGINS` JSON map on all workers, and set the same strong `TRYORA_WORKER_SECRET` (at least 32 characters). For example, a map can associate `a` with `http://worker-a:3000` and `b` with `http://worker-b:3000`. Every origin must address that specific worker, not a load-balanced service. Restrict the internal endpoint to the app network; use HTTPS for traffic that crosses an untrusted network. No hosting configuration has been changed.
3. Instances must have a long-lived Node process to run transient jobs and cleanup intervals. A completely stopped app cannot execute cleanup; the next storefront configuration/start request recovers stale reservations. A worker restart deliberately loses image bytes, so the shopper must retry with a new job; its lost job is released rather than charged.
4. OpenAI is not connected. A real adapter must implement room analysis, generation, semantic result checking, cancellation and confirmed retention settings. The mock explicitly accepts its unchanged-room development result. Actual model fidelity and retention behavior cannot be established by the mock tests.
5. Cancellation stops the application from accepting late output and requests upstream cancellation. JavaScript cannot forcibly erase buffers retained by a faulty adapter that ignores its signal. Do not enable such an adapter. Upstream charges that are not reported after a timeout remain unknown and need provider-side reconciliation.
6. A browser that closes or stays offline before acknowledgement can receive bytes without a settled merchant credit. Retries improve reliability while the page is alive; this limitation follows the existing credit-on-browser-acknowledgement policy. Ready bytes and unused reservations expire normally.
7. Existing dependency audit advisories remain; no broad or breaking `npm audit fix --force` upgrade was attempted. The new app test runner uses Vitest 4 instead of the older vulnerable version. React Router v8 future-flag notices and empty chunks for server-only routes are non-failing build warnings.

Worker routing has unit coverage and the persistent engine has local PostgreSQL coverage. A live multi-worker hosting test and real Shopify/OpenAI calls remain part of a later integration/release exercise; this task did not contact production APIs.
