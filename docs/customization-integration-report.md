# Customization integration completion report

## Scope and architecture

This increment implements an opt-in, tenant-scoped provider foundation while
retaining the legacy native path. It does not claim universal third-party coverage.

The server registry uses the existing CustomizationAdapter contract through a
ProviderAdapter specialization. Native delegates to the existing resolver; Manual
projects merchant-reviewed exact native tuples; Cloudlift and unknown providers
reject authorization. Provider discovery, browser selection synchronization and
server authorization remain distinct. Public labels are separate from server-only
configuration, Prisma and authentication code.

Provider snapshots carry scope, provider/version/revision, verification time,
actual combinations/native option IDs where supplied, stock, and supported swatches.
Approved server results carry the exact variant/native options and nonempty approved
full-product reference list. Native/Manual discovered IDs round-trip through validation.

## Provider support matrix

| Provider | Implemented/tested | Live status |
| --- | --- | --- |
| Shopify Native | Registry adapter, existing native behavior, exact variant/option/reference validation, native option/value IDs | Existing source preserved; this increment not live-tested |
| Manual / Custom Mapping | Strict draft/activation workflow, product-scoped exact native/composite bindings, swatches, preservation groups, per-preview validation | Opt-in; synthetic fixtures only, no real mapping activated |
| Cloudlift | Explicit disabled adapter, capability/status diagnostics, selected provider persistence | Needs setup; no authoritative source verified |
| Other/unknown | Fail-closed fallback | Not supported |

Manual Mapping is not Cloudlift support: only reviewed configurations bound to native
Shopify variants are accepted. No native combinations, inventory or images are invented.

## Completed stages

- **A — Audit:** baseline 231 passing / 4 skipped, typecheck/build passed. Existing
  architecture, schema, native queries, theme, reference-download and credit lifecycle
  reviewed. Merchant confirms Cloudlift; complete live option/media data remains absent.
- **B — Registry:** common native/manual/disabled adapters, explicit unsupported status,
  scoped effective settings, bounded evidence reads, exact ID contract tests.
- **C — Merchant configuration:** store defaults and product overrides; authenticated
  admin route, safe request limits, concurrency revisions, setup diagnostics, product
  ownership checks, product/native evidence and profile coverage view. Additive schema
  and unapplied SQL artifact; default-off server gate preserves existing installations.
- **D — Native/composite:** merchant-selected exact role names; no prefix stripping or
  delimiter parser. Complete tuple and preserved-configuration validation; stale/ambiguous
  bindings, invalid media, changed size/configuration and unavailable variants rejected.
- **E — Cloudlift:** official documentation reviewed; disabled implementation and access
  requirements documented. No external catalogue/selection integration is activated.
- **F — Manual workflow:** bounded JSON editor with inactive template, product media
  evidence, draft save, explicit review, live validation and activation. Real profiles
  need complete data and merchant image/equivalence review; no visual mapping wizard.
- **G — Regression/build:** native legacy suite plus provider, admin-security, mapped
  credit lifecycle, revision, dynamic selection, listener/timer and keyboard tests.

## Validation and tools

Final command results and implementation commit IDs are recorded below after checks.
No migration, production mutation, deployment, PR or remote push was performed.
Prisma Client was regenerated. Prisma schema validation passed with a placeholder
localhost URL (no database connection). The migration SQL itself was not applied.

Shopify's GraphQL validator accepted both modified queries against Admin 2026-07.
It flagged the existing deprecated ProductVariant.image usage; migration to media
is future work. No Shopify scope configuration was expanded.

The standalone Polaris validator lacked TypeScript initially. Loading the repository's
existing TypeScript allowed it to start, but its isolated Preact/JSX environment still
could not typecheck this React App Home route. No dependencies were installed to mask
that mismatch. Real repository React/Polaris typecheck and production client/server
builds are the executable UI verification; live visual QA remains outstanding.

## Security and compatibility assessment

Authentication supplies shop identity. Client scope, URLs and labels do not override
stored profiles. Product-scoped settings require an Admin product lookup. Persisted
profiles are re-parsed at use, exact native tuples/media re-read, and provider revision
checked. Settings writes use tenant/product-scoped optimistic revisions in a transaction.
Legacy product enabled/OFF flags and credit/billing records are not rewritten.

Manual previews require an exact mapped source and target variant, unchanged fixed
native options and reviewed preserved dimensions. Frozen context and original merchant
variant/availability restrictions still apply. Only live availableForSale authorizes
stock. Full-product references must exist in this product's media; swatches cannot also
serve as those references. No client-supplied media URLs are downloaded.

Mapping inputs and provider reads are bounded. There is no cross-tenant data cache,
private endpoint, secret exposure or new external dependency. No Cloudlift event data
is trusted. Provider validation occurs before room analysis/job credit reservation;
unsupported/missing-reference requests are tested to leave balance intact. Valid mapped
previews use the original delivered-image acknowledgement/credit path.

The popup retains native size and reviewed configuration groups. It invalidates cached
results and obsolete in-flight work when form identity changes, does not acknowledge
obsolete results, and removes active listeners/timers on close. No product form or
checkout mutation was added. Existing attribution behavior is unchanged.

These are code-level controls and synthetic tests, not an independent penetration
test, visual proof of asset accuracy, migration execution test or real-store certification.

## Blockers and next controlled release step

Follow `customization-provider-setup.md` for the migration baseline/review gate,
feature opt-in, mapping workflow, limits and safe rollback sequence. Do not enable
production simply because the build passes. Existing deployment startup may push the
schema; review that behavior explicitly before a separately authorized release.

Obtain complete Aspen/Aria native variant data and product media, plus documented
authenticated Cloudlift configuration/dependency/variant-link data. Review all composite
suffix meanings, exact available combinations, swatch provenance and appropriate
full-product images. No real Aspen grammar or availability was inferred from truncated
text or approximate variant counts.

A controlled next step is one authorized staging product using Native or an exact
reviewed Manual profile, followed by database/migration smoke testing, theme/browser
mobile/desktop/keyboard QA, product-form/checkout checks and delivered/expired credit
checks. Cloudlift remains Needs setup until a supported server-side contract and
separately verified synchronization implementation are available.

Known limits include the advanced JSON-only mapping editor, product-media-only manual
swatches, no verified nonvariant external properties, manual semantic review of opaque
preservation groups/images, no new distributed discovery cache/rate limiter, existing
multipart-envelope behavior, SDK cancellation limits, and opt-in flag rollback semantics.
The setup document records each operational boundary.
Authorization is checked at generation entry; remote approval/profile edits do not
retroactively revoke already-running authorized jobs. Browser-native selection
changes are separately guarded before display/acknowledgement. Stronger mid-job
server revocation remains an explicit follow-up rather than a claimed capability.

## Final results and local commits

- npm test: 292 passed, 4 skipped (71 core + 221 app); baseline was 231 passed, 4 skipped. This adds 61 regression cases.
- npm run typecheck: passed.
- npm run build: passed; storefront bundle synchronized with source.
- Prisma generate and schema validation: passed; no database connection/migration applied.
- Shopify Admin 2026-07 query validation: passed with the existing image deprecation warning.
- Git diff whitespace checks and core deployment-copy synchronization checks: passed.
- Local commits: f4265e9 (preserved composite plan), 124a1b0 (registry/schema/mapping adapters), 37777b9 (merchant configuration), 84a20f3 (storefront validation/synchronization).
- The final documentation commit also clarifies the pause impact of incomplete provider selection in the admin. Its hash is supplied in the completion message/Git log.

Added files customization-providers.test.ts and customization-admin.test.ts cover runtime boundaries and authenticated saves. Existing popup.test.ts and storefront.test.ts now cover mapped requests, invalidation, listeners/timers, keyboard controls, unsupported rejection before credits, and exact-reference acknowledgement settlement. All new product fixtures are synthetic.

## Exact file manifest

```text
docs/composite-native-options-plan.md
docs/customization-architecture.md
docs/customization-integration-report.md
docs/customization-provider-setup.md
docs/fabric-colour-selector.md
docs/selector-discovery-audit.md
packages/core/src/customization-adapter.ts
packages/core/src/customization.ts
packages/storefront/src/main.ts
shopify-app/app/core/customization-adapter.ts
shopify-app/app/core/customization.ts
shopify-app/app/customization/adapters/cloudlift.server.ts
shopify-app/app/customization/adapters/manual-mapping.server.ts
shopify-app/app/customization/adapters/shopify-native.server.ts
shopify-app/app/customization/adapters/types.server.ts
shopify-app/app/customization/option-model.ts
shopify-app/app/customization/provider-catalog.ts
shopify-app/app/customization/provider-config.server.ts
shopify-app/app/customization/reference-resolver.server.ts
shopify-app/app/customization/registry.server.ts
shopify-app/app/customization/validation.server.ts
shopify-app/app/preview-product.server.ts
shopify-app/app/products.server.ts
shopify-app/app/routes/app.customization.tsx
shopify-app/app/routes/app.products.tsx
shopify-app/app/routes/app.products_.$id.tsx
shopify-app/app/routes/app.tsx
shopify-app/app/routes/proxy.$.tsx
shopify-app/app/storefront.server.ts
shopify-app/extensions/tryora-theme/assets/tryora.js
shopify-app/prisma/migrations/202610230001_customization_config/migration.sql
shopify-app/prisma/migrations/migration_lock.toml
shopify-app/prisma/schema.prisma
shopify-app/test/customization-admin.test.ts
shopify-app/test/customization-providers.test.ts
shopify-app/test/fixtures/provider-mapping.ts
shopify-app/test/popup.test.ts
shopify-app/test/storefront.test.ts
```
