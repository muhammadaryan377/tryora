# Premium fabric/colour selector audit — 24 October 2026

## Base and history

Repository: tryora-assistant-v2. Dedicated branch: fix/premium-fabric-colour-selector.
Started from clean 59510c3 on fix/assistant-conversation-state, retaining 5223bec,
bbf7edb and 59510c3. No changes to the assistant conversation-state implementation.
Refreshed origin/main read-only: 0ef68ef (PR #12). These three local fixes remain above main.

Relevant existing implementations (already in main and this base):

- 2856735: dependent native Fabric → Colour selector, variant preservation, exact references.
- 10302cd: Cloudlift native-linked reviewed storefront swatches.
- 449ddc0: opt-in merchant-reviewed Cloudlift mapping activation.
- 35d87c9 / 575db11: fail-closed native source matching.
- 6f2b8cc / be03e8c: premium Room Assistant drawer and in-card options. That separate
  drawer design does not automatically restyle the product preview popup.

The existing native popup has fabric chips, actual image samples, accessible text fallbacks
and dependent grouping. Its default colour radius varies by template. No separate lost
premium product-popup implementation was identified in the inspected history.

## Confirmed code causes and evidence limits

1. nativeSelections (packages/core/src/customization.ts) creates dependent groups only
   from recognized separate native Fabric and Colour options. It deliberately does not
   parse arbitrary composite strings or external app configuration.
2. Numbered prefixes such as "2. Choose Your Fabric" were not recognized by
   nativeOptionRole. This change removes only a leading numeric dot/parenthesis prefix
   before bounded alias classification; original Shopify names remain authoritative.
   Missing/stale saved option names are not repaired, and explicit null mappings remain null.
3. selectedVariant (packages/storefront/src/main.ts) preserves every option outside
   selectionOptionNames. A composite containing fabric, colour and other choices cannot
   change when only Fabric is configured as varying. This can legitimately leave just one
   fabric previewable. Unlocking arbitrary other composite tuples would risk changing
   headboard/storage, so that behavior is retained.
4. The screenshot's exact old warning comes from the fabric-only fallback in swatches().
   An active current manual/Cloudlift projection supplies Colour plus a virtual fabric
   grouping, so the screenshot is consistent with missing/unavailable reviewed mapping
   or a native-only configuration. It does not prove the saved provider, feature flag,
   live backend commit, or active Shopify extension version.
5. Text fabrics occupied six narrow grid columns and each nonmatching value added a
   nonwrapping "Unavailable" caption. This was a genuine overlap and terminology bug:
   missing preview support is not evidence of sold-out inventory.

No complete merchant CSV/variant export was found. No authenticated merchant data,
saved Avelor mapping, or active Shopify app version was accessed. Public Aspen redirected
to the password page; Aria could not be fetched. We did not bypass storefront protection.
Cloudlift-specific code exists, but that does not verify Avelor's current provider setup.

## Focused changes

- Bounded numbered option recognition in core, regenerated into shopify-app/app/core.
- Circular actual image/colour samples; text fallbacks remain readable text, without
  invented textures or colour dots.
- Fabric text cards get adequate width, wrapping and mobile horizontal scrolling.
- Unsupported choices remain disabled and have explicit accessible preview explanations;
  repeated "Unavailable" labels and misleading sold-out styling are removed.
- Missing colour mapping receives a truthful notice. No colours, variant combinations,
  sample images, provider activation or reference approvals are synthesized.
- Generated tryora.js rebuilt from source. No Prisma/schema/startup, checkout, credits,
  reference resolver, provider authorization or merchant configuration changes.

## Existing data and reference path retained

Separate native options: nativeSelections → eligibleVariants → popup selectedVariant →
server resolvePreviewProduct. Exact availableForSale and preserved options are checked.

Composite/native-linked products: existing merchant-reviewed ManualMapping with exact
variantId, complete nativeOptions, role names, stable fabric/colour IDs, and reviewed
preserved dimensions. manualStorefrontData presents groups and verified swatchMediaId.
manual-mapping/Cloudlift adapters validate source/target identities, live tuples,
mapping revision, approved product-owned referenceMediaIds and preservation before
job/credit reservation. Browser events and client image URLs are never approval evidence.

## Avelor requirements to finish live verification

Obtain a merchant-authorized complete Aria/Aspen variant export (untruncated option names,
values and exact IDs), all selected size/headboard/storage tuples, product-owned media
IDs, approved full-product reference bindings and optional separate fabric sample IDs.
Inspect the current product provider override, active mapping revision and feature flag
through authorized Tryora Admin; do not assume a provider from labels.

If colours are native composite variants, use the existing reviewed manual mapping path
(or Cloudlift native-linked only when that mode is verified). If colours are independent
external properties, this bridge cannot authorize them: a verified authenticated provider
configuration and full-product reference source are still required.

## Validation

- npm test: 75 core + 422 app passed; 20 app tests skipped in the standard run.
- npm run typecheck: passed.
- npm run build: passed, including generated /apps/tryora bundle.
- TRYORA_E2E=1: popup-browser.e2e + assistant-browser.e2e: 10 passed in Chrome.
  Four new tests cover desktop/mobile real sample display, fabric-dependent colour sets,
  text fallback, exact unchanged cart ID, disabled composite mismatches, label bounds and
  non-overlap. Six existing assistant journeys also passed.
- Existing provider/native suites cover exact reference rejection, missing mapping/media,
  ambiguous bindings, unavailable variants, source identity, tenant isolation and credits.
- All browser data is synthetic and intercepted locally; no live merchant or AI calls.
- git diff --check: passed.

## Release and rollback (instructions only)

1. Review this branch together with the preserved conversation-state commits; the local
   base contains three fixes not in origin/main. Do not release a generated bundle from
   a different assistant backend revision.
2. Verify authorized Aria data and reviewed mappings in staging first. Confirm the
   preservation of size, headboard and storage, live availability, full-product references,
   unsupported combinations, page changes during generation and credit settlement.
3. Review the target environment's existing provider-table rollout separately. This patch
   needs no migration and does not activate providers; an OFF flag must remain OFF unless
   the existing infrastructure and merchant mapping have been approved independently.
4. Build the approved commit. Release the matching Railway backend, then the Shopify theme
   extension assets using the existing app configuration. No new Shopify app is needed.
5. Verify the active extension version and served JS/CSS against the approved build, then
   smoke-test native, mapped and unmapped products on desktop/mobile plus assistant journeys.
6. On regression, restore the previously recorded Shopify app/extension version and
   Railway deployment from the same known-compatible revision. No database rollback is
   needed for this patch; do not delete tables or modify merchant mappings as a code rollback.

No push, release, deployment, production settings changes or database writes were performed.
Live success remains conditional on verified merchant data and configuration.
