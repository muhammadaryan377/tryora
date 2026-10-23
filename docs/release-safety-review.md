# Release safety review — 23 October 2026

## Decision and candidate

**NO-GO for production now. GO for native-only staging verification.** No migration,
production access, push or deployment was performed. The former Docker startup could
apply the provider schema with the flag OFF. That path is now removed locally.
Latest upstream main, actual Railway settings, a Linux container and live-store
backend/theme compatibility still need verification before production approval.

Recommended source: local **release/native-selector-review**, based on `3f52d7a`.
It retains the six native-selector commits after cached main and adds startup
hardening plus existing native popup guards from `84a20f3`, excluding provider
fields/tests. It has no provider registry/settings page, CustomizationConfig model
or provider migration directory. The unused type-only adapter contract from
`a75443f` does not activate an integration. The active development branch remains
**fix/fabric-colour-selector**; all provider work is preserved there.

## Audit scope and upstream limitation

- Audited development source: `caa5906` plus this safety follow-up. The initial
  diff contains 50 files, 2,862 additions and 166 deletions; manifest below.
- Cached origin/main: `5bfd21889e5929b61e2dae113c537a0252df9cef` (PR #6 merge,
  23 October 2026). Both `git fetch origin main` and the connected GitHub reader
  failed with repository-not-found/404. **This is not a certified latest-main
  audit.** Restore read access, fetch, reconcile upstream changes and repeat checks
  before release. No remote URL was changed.
- Reviewed native discovery/resolution, admin diagnostics, native/provider storefront
  paths and assets, provider config/adapters, scope/input/media validation, SQL/schema,
  startup, regression tests and investigation/rollout documents.
- Credit engine, image provider, furniture prompt, worker, lockfiles, existing SQL,
  app scopes/URLs/webhooks, extension TOML and Liquid are unchanged versus cached main.
  No checkout or product form value mutation was added. The exact variant still
  enters the existing reference/image-generation/credit lifecycle.

## Database and startup inventory

| Item | Original diff versus cached main | Effect |
| --- | --- | --- |
| schema.prisma | Adds CustomizationConfig and Shop.customizationConfigs | One physical table; reverse relation adds no Shop column |
| New fields | shopId/productId TEXT compound PK; providerId TEXT default shopify_native; revision TEXT; active BOOLEAN default false; nullable mapping JSONB; updatedAt TIMESTAMP(3) | No existing-row backfill; Prisma supplies updatedAt (no SQL default) |
| New foreign key | shopId → Shop.id, delete/update cascade | Can briefly lock referenced table during DDL |
| migrations/202610230001_customization_config/migration.sql | New additive table SQL | Unapplied; equivalent to offline Prisma schema diff |
| migrations/migration_lock.toml | New PostgreSQL metadata | Not a baseline of the existing database |
| prisma/changes/provider-usage.sql | Unchanged existing artifact | ProviderUsage is already in main; do not apply this SQL twice |
| autoEnableProducts, autoConfigured and all other models | Already in cached main; unchanged | Native-only needs no new columns |
| Dockerfile/package.json | Originally unchanged startup: docker-start → setup → generate + db push → server | Runs before JS flags; OFF cannot prevent schema changes |
| shopify.web.toml | Originally unchanged dev command ran migrate deploy | Starting dev could apply/fail incomplete new history |
| Railway command overrides/triggers | Not captured in repository config; inaccessible here | Actual dashboard/CI settings require operator inspection |

Offline `prisma migrate diff` between the native and full schemas confirmed only
CREATE TABLE CustomizationConfig, primary key and foreign key. No DB was used.
db push synchronizes the entire schema, bypasses migration history and ignores
application flags; additive changes can proceed without a data-loss warning.

Safety changes made in this review:

- Docker build: `npm run setup && npm run build`; setup is **prisma generate only**.
- docker-start: **npm run start only**, targeting react-router-serve.
- Shopify dev: react-router dev only; predev still generates the client.
- Three regression tests pin script/lifecycle hooks, Docker and dev behavior.
- README and provider setup/report links now reflect the non-DDL startup contract.

An empty database no longer bootstraps during startup. Provision it separately.
Existing databases must match the native baseline; removing db push intentionally
exposes drift instead of repairing it during application startup.

## Merchant compatibility and release scope

Native-only schema is byte-for-byte identical to cached main. Its backend has no
provider imports or CustomizationConfig calls. On the full branch, flag unset/false
also skips new-table reads and defaults to Native; no saved manual OFF is overwritten.
Shipping that larger branch flag-off is possible after hardening, but is not the
recommended release: it includes unnecessary, not live-validated provider code/UI/schema.

Native-only retains bounded discovery, missing/stale diagnostics, native Fabric →
Colour combinations, supplied swatches, exact variant/size/other native options,
frozen/merchant restrictions, live availableForSale and reference checks. Missing
stock/references or ambiguous context fail before generation/reservation. Existing
single-selector and no-selector flows stay covered. Page-change guards invalidate
obsolete results before display/acknowledgement and clean up listeners/timers.

No composite parser or Cloudlift support is released. Numbered names and opaque
composite values still need explicit reviewed mapping. This release does **not**
claim to solve Aspen/Aria colour customization.

Dependent selectors use a JSON fabric/colour pair instead of a plain option string.
Old widget/new backend and new widget/old backend can fail on those products; older
multi-variant clients without exact IDs are also refused. This is fail-closed, not
seamless backward compatibility. Do not bypass validation or substitute variants.
Stage old/old, old/new, new/old and new/new pairs for colour-only, fabric-only,
dependent, no-selector, stale, unavailable and missing-reference products. Verify
refusals use no credit. Affected products require a coordinated short preview pause.
Shopify propagation and already-open pages are not atomic. If uninterrupted previews
on cached old pages are mandatory, **NO-GO until reviewed protocol compatibility exists**.

## Native-only Railway and Shopify sequence — not executed

1. Restore origin read access, fetch latest main, reconcile and repeat checks on the
   final candidate. Obtain explicit release approval for the commit, Railway service/
   environment and Shopify app. No audit action implicitly authorizes a push/merge.
2. Privately capture current Railway image/deployment/variables/settings and active
   Shopify app version. Verify backup/PITR and restore. Compare live DB schema read-only
   against native baseline, including Session refresh fields, auto-enable columns
   and ProviderUsage. **No native release DDL**; drift is a stop condition.
3. Pin the native-only final commit for both artifacts. Railway context/root:
   shopify-app; Dockerfile: Dockerfile; runtime: hardened docker-start. Inspect dashboard
   and CI start/pre-deploy/build overrides and auto-deploy triggers. None may run an old
   setup, db push or migrate deploy. Native pre-deploy DB command is empty. Provider
   flag stays false/unset; preserve other variables/secrets and merchant settings.
4. In isolated staging, build the actual image from repo root:
   `docker build -t tryora-native-review ./shopify-app`.
   Start/restart it against a provisioned native-schema DB without provider tables,
   using a runtime role with no DDL permissions. Check health/auth/Products, proxy,
   auto-enable/manual OFF, all supported selectors/no-selector and exact references.
   Complete desktop/mobile/keyboard/form-change QA and the four backend/widget pairs.
   Check delivery/duplicate ack, failed/expired jobs and credits. Explicitly authorize
   isolated tryora_test_* PostgreSQL tests and any paid image smoke test separately.
5. Validate staging extension behavior using a separate development app/store. After
   approval, from the candidate's shopify-app directory, use the pinned production
   CLI/config to validate then prepare an inactive production version:
   `.\node_modules\.bin\shopify.cmd app config validate --json`
   then `.\node_modules\.bin\shopify.cmd app deploy --no-release --version native-selector-RELEASE_SHA`.
   Substitute the approved commit for RELEASE_SHA. Inspect app identity, URLs, scopes,
   webhooks and extension identity against the active version; include no unrelated
   config change. --no-release uploads an inactive app version, not a backend, and
   still needs authorization. Do not run these commands as an unapproved audit step.
6. In the approved release window, snapshot affected products' ON/OFF and manual/
   automatic ownership. Pause only affected previews through existing settings and
   let in-flight jobs settle/expire. Verify the pause; keep checkout and compatible
   previews running. If current controls cannot pause that set safely, stop. Never
   globally re-enable existing manual OFF products or change auto-enable policy.
7. Deploy the pinned native-only backend to Railway **first, with no migration**.
   Verify startup/health/auth/proxy and compatible previews. Stop on reference/credit
   anomalies. Dependent old widgets stay in the paused/fail-closed population.
8. Release the matching prepared Shopify version:
   `.\node_modules\.bin\shopify.cmd app release --version native-selector-RELEASE_SHA`.
   Wait for propagation; verify actual JS/CSS and exact request payloads on fresh pages.
   This updates app configuration/extensions, independently of Railway.
9. Smoke-test the new/new production pair on approved products: size/fabric/colour/
   other choices, missing reference and stock refusal, unchanged checkout form and
   credit only on acknowledged delivery. Restore only the recorded formerly ON
   products with original ownership/settings. Keep pre-existing manual OFFs. Refresh
   already-open pages; monitor errors, references and credit outcomes during an agreed
   observation window. Synthetic tests alone do not sign off production.

Rollback: pause affected previews and settle jobs. Release the recorded older Shopify
version and restore a compatible known-good Railway image **with hardened non-DDL
startup**. Prepare that rollback image in staging before release. An arbitrary older
image still invokes db push and is unsafe. Recheck restored variables/overrides,
validate a matching backend/widget pair, then restore only recorded product settings.
Native-only has no DB change to undo. Railway rollback does not undo DB writes and
can restore historical custom variables; recheck flags rather than assuming them.

## Explicit future provider migration and rollback plan

This is a separate release/change approval. The SQL has not been execution-tested.

1. Keep production native-only. Obtain complete native variant/media evidence and a
   reviewed mapping. Cloudlift remains unverified/disabled.
2. Inspect an authorized DB clone: schema/drift, migration history, constraints/indexes,
   row counts and merchant/OFF/credit invariants. Verify backup restore. Never reset a
   populated DB. The checked-in history contains only the provider delta, not a baseline.
3. Generate/review a **0_init baseline of the actual existing native DB**, preserving
   unsupported SQL features. Do not baseline the new provider-bearing schema. With
   pinned Prisma 6.19.3, offline generation uses
   `prisma migrate diff --from-empty --to-schema-datamodel native-baseline.prisma --script`.
   Commit the reviewed UTF-8 output in prisma/migrations/0_init/migration.sql before
   the existing delta. Do not delete/rewrite the delta or mark it applied prematurely.
4. Rehearse empty DB (apply baseline then delta) and existing native clone (mark **only
   0_init** applied via `prisma migrate resolve --applied 0_init`, then `prisma migrate
   deploy`). These are DB writes, **not executed/authorized here**. resolve creates
   _prisma_migrations metadata; it does not prove schema equality. If the provider
   table already exists from earlier db push/manual SQL, stop, compare its complete
   definition and reconcile history explicitly; do not conceal drift with IF NOT EXISTS.
5. Rehearse locking/timeouts, fresh installs and native rollback. Delta creates one
   table/PK/FK; no existing rows need backfilling. Set reviewed lock/statement timeouts,
   serialize execution and fail on errors. No db push, migrate dev/reset, data-loss
   flags or destructive down migration in production.
6. After backup and separate production approval, register the reviewed baseline and
   apply the delta once through an audited DDL release job. Railway pre-deploy can
   gate release on failure, but only after baselining and staging verification; never
   run schema changes at app startup. Keep runtime credentials without DDL privileges.
   Verify migration state, exact PK/FK/defaults/columns and unchanged native/credit data.
7. Deploy provider backend with flag OFF. Test it on the migrated DB, then enable only
   in staging first with Native defaults. Separately approve one product override;
   verify reviewed references, revisions and current variants before wider activation.

Provider rollback retains the additive table, rows and migration history. Pause manually
mapped products before disabling the flag: flag OFF returns to legacy native behavior.
Settle/expire jobs first; remote mapping edits do not retroactively revoke authorized
work. Export profile revisions/settings before edits. Roll back to a hardened native
image that ignores the extra table. No automatic DROP TABLE. Any eventual removal
requires separate approval, proof of no readers/writers, profile backup and migration
history reconciliation. Never restore the whole old DB just to undo this additive
table: that would discard newer merchant/credit writes. Inspect failed/partial state
and review a repair before retry/resolve; never blindly mark a failed migration applied.

## Validation and outstanding gates

| Check | Full branch | Native-only candidate |
| --- | --- | --- |
| npm test | 295 passed, 4 skipped (71 core + 224 app) | 237 passed, 4 skipped (71 core + 166 app) |
| npm run typecheck | Passed | Passed |
| npm run build | Passed; bundle synchronized | Passed; native bundle regenerated |
| npm --prefix shopify-app run setup | Generate only; passed | Native-schema client generation; passed |
| Offline schema comparison | One additive table | Identical to cached origin/main |
| DB/paid API tests | Not run | Not run |
| Linux Docker build/start | Not run: daemon unavailable | Staging gate |
| Actual Shopify/Railway settings and live QA | Inaccessible/unverified | Release gate |
| Latest Bilal main | Fetch/connected reader failed | Release gate |

Four skips: three isolated PostgreSQL tests and one paid OpenAI smoke. Opt-ins were
disabled; no DB or paid API was used. No dependency/schema upgrade was made. Script
regressions do not replace a Linux image smoke test. Worktrees reused dependency
folders; clients were generated sequentially for each schema and the development
client restored at the end. Operator CI must do a clean lockfile install in Docker.
The inherited dev-seed route remains authenticated and test-store restricted; removal
before broader launch is an existing task, not part of this selector release.

## Official operational references

- [Prisma: baselining](https://www.prisma.io/docs/orm/prisma-migrate/workflows/baselining)
- [Prisma: production migration workflow](https://docs.prisma.io/docs/orm/prisma-client/deployment/deploy-migrations-from-a-local-environment)
- [Railway: pre-deploy commands](https://docs.railway.com/deployments/pre-deploy-command)
- [Railway: rollback image and variables](https://docs.railway.com/guides/roll-back-bad-deploy)
- [Shopify: inactive versions, release and rollback](https://shopify.dev/docs/apps/launch/deployment/deploy-app-versions)

Installed CLI 4.9.4 help confirms deploy --no-release/--version and app release.
Help only was run: no upload, auth, config validation or release. Recheck procedures
at execution time. This is not external-option support or App Store certification.

## Original 50-file diff manifest

The manifest is caa5906 versus cached origin/main before this startup/runbook follow-up.
```text
docs/composite-native-options-plan.md
docs/customization-architecture.md
docs/customization-integration-report.md
docs/customization-provider-setup.md
docs/fabric-colour-selector.md
docs/selector-discovery-audit.md
packages/core/src/customization-adapter.ts
packages/core/src/customization.ts
packages/core/src/native-option-discovery.ts
packages/core/test/native-option-discovery.test.ts
packages/storefront/src/main.ts
shopify-app/app/auto-products.server.ts
shopify-app/app/core/customization-adapter.ts
shopify-app/app/core/customization.ts
shopify-app/app/core/native-option-discovery.ts
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
shopify-app/app/native-selection.server.ts
shopify-app/app/preview-option-status.ts
shopify-app/app/preview-product.server.ts
shopify-app/app/products.server.ts
shopify-app/app/routes/app.customization.tsx
shopify-app/app/routes/app.products.tsx
shopify-app/app/routes/app.products_.$id.tsx
shopify-app/app/routes/app.tsx
shopify-app/app/routes/proxy.$.tsx
shopify-app/app/storefront.server.ts
shopify-app/extensions/tryora-theme/assets/tryora.css
shopify-app/extensions/tryora-theme/assets/tryora.js
shopify-app/prisma/migrations/202610230001_customization_config/migration.sql
shopify-app/prisma/migrations/migration_lock.toml
shopify-app/prisma/schema.prisma
shopify-app/test/auto-products.test.ts
shopify-app/test/customization-admin.test.ts
shopify-app/test/customization-providers.test.ts
shopify-app/test/customization.test.ts
shopify-app/test/fixtures/provider-mapping.ts
shopify-app/test/fixtures/selector-audit.ts
shopify-app/test/popup.test.ts
shopify-app/test/preview-option-status.test.ts
shopify-app/test/selector-audit.test.ts
shopify-app/test/storefront.test.ts
```
