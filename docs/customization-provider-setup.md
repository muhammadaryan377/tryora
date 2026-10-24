# Provider foundation: installation and merchant setup

> **Update (Cloudlift native-linked branch):** Cloudlift may now be selected on a single product with a reviewed exact native-variant mapping, following [cloudlift-native-linked.md](cloudlift-native-linked.md). Unmapped Cloudlift-only custom properties and external image libraries remain unsupported. The provider feature flag, additive table and real-store verification gates below are still mandatory.\n\n
## Release gate

This implementation is local and opt-in. No database migration or production
mutation was performed. `TRYORA_CUSTOMIZATION_PROVIDERS_ENABLED` is unset/false
by default. With it off, existing native previews do not query the new table.

The new `CustomizationConfig` table is additive and contains store defaults
(`productId = "__store__"`) and exact product overrides, scoped by shop and product.
It stores provider IDs, optimistic revisions, activation state and reviewed mapping
JSON. It does not replace product enabled/OFF settings, credits or billing tables.

Before enabling in an authorized staging environment:

1. Review the schema and additive SQL in
   `shopify-app/prisma/migrations/202610230001_customization_config/migration.sql`.
2. The repository previously had no Prisma migration history. Do **not** assume
   `prisma migrate deploy` can adopt an existing nonempty database automatically.
   An operator must review/baseline the existing schema or separately apply the
   reviewed additive SQL through the approved database process. Test that process
   on staging first. No reset or blind db push is part of this rollout.
3. Regenerate Prisma Client for the deployment, verify the table, then enable the
   server-only flag in staging. Existing `docker-start` invokes a schema-push setup
   script; review that deployment behavior rather than treating it as migration review.
4. Leave the store default Native initially. Configure one product override using
   an authenticated merchant account. Never paste credentials into a mapping.
5. Complete the real-store validation checklist before a separately approved release.

The migration SQL has been schema-reviewed but not applied or smoke-tested against
a real database during this task. The database URL was unavailable; schema validation
used a placeholder localhost URL and opened no database connection.

## Merchant workflow

- **Customization providers** in the admin navigation edits the store default.
- Each Products row and product settings page links to its provider override.
- Shopify Native Options preserves the existing native selector/reference path.
- Cloudlift/Other can be recorded as selected but always show Needs setup and cannot
  authorize generation. They do not silently fall back to Native.
- Manual / Custom Mapping is a reviewed **native-variant projection**, not an
  implementation of arbitrary external properties. A store-wide Manual default
  requires individual product profiles; it is not a connected provider.
- Use **Current native Shopify evidence** to inspect complete option values, IDs,
  current `availableForSale`, variant tuples and product media. Availability is not
  inferred from location inventory quantities.
- The editor includes an inactive JSON template. Replace every placeholder and
  remove absent roles. Full raw native strings remain opaque; no delimiter grammar
  is assumed. Product-specific role names can be numbered, custom or localized.
- Save a structurally valid reviewed profile as a draft, then check the review
  acknowledgement and select **Validate and activate mapping**. Activation re-reads
  live bindings/media. Invalid activation writes no settings.
- Correct stale profiles using current native evidence and explicitly activate a
  new revision. Unknown variants remain unoffered. The admin reports coverage and
  unbound variant counts; an active profile does not claim full product coverage.

Existing product enabled/readiness checks still apply. A profile does not enable
a manually OFF product or bypass original merchant restrictions. New shop records
use the same automatic-product default as existing Tryora shop initialization;
existing shop settings are not overwritten.

## Mapping invariants

Profiles require schemaVersion 1, providerId `manual_mapping`, the exact shop and
product IDs, reviewed=true, roles and entries. Each entry contains:

- Stable entry ID and exact native variant GID.
- Complete nativeOptions dictionary (all original names and full values).
- Stable fabric/colour IDs and reviewed display labels.
- Explicit preserved configuration dimensions, with consistent dimension names
  across entries. Every embedded suffix choice must be reviewed; the validator
  cannot infer its human meaning from an opaque string.
- One to four approved full-product Shopify MediaImage IDs from this product.
- An optional distinct product-media swatch ID. A sample cannot also approve the
  full-product reference. Missing swatches use accessible text.

Bindings are checked against current native tuples. Duplicate identities, conflicting
fabric labels, ambiguous composite meanings, reserved fields, missing dimensions,
unknown fields and cross-tenant/product profiles are rejected. No arbitrary parser,
URL, browser event or label can authorize a configuration.

Colour switching requires an available exact native target, unchanged size and
other fixed native options, and identical reviewed preservation dimensions. Multiple
matches or an unmapped current native variant block selection. The server checks
the original variant, target variant, provider revision, frozen settings, existing
merchant restrictions and approved references again before generation/credits.

Swatches currently must be product-owned Shopify media. This does not import
Cloudlift-hosted samples or arbitrary file-library assets. Text fallback is used
when a reliable supported sample is absent.

## Cloudlift evidence and boundary

Official sources reviewed:

- [JavaScript Events](https://docs.cloudlift.app/article/181-javascript-events-options):
  selection/render notifications support storefront customization hooks. They do
  not establish the complete catalogue or generation approvals.
- [Custom CSS and JavaScript](https://docs.cloudlift.app/article/190-how-can-i-add-custom-css-and-javascript):
  configuration-scoped code can run after rendering; global customization is also
  described. This is not a server-side approval contract.

The merchant has identified Cloudlift as Avelor's provider. No authenticated
Cloudlift catalogue, complete Aspen export, variant-link schema or approved image
coverage was available here. This does not assert that Cloudlift has no suitable
API; it means no such source has been verified for Tryora. The disabled adapter
does not call private endpoints, scrape private state, or install event listeners.

To implement a live adapter, obtain a documented authorized product-scoped source,
stable option/value IDs, dependency and availability semantics, native-variant
links, selected-configuration identity, swatch provenance and approved full-product
references. Contract-test those separately from browser synchronization.

## Operational limits and rollback

- Admin forms are streamed with a 1.6 MB encoded-body ceiling and 512,000-character mapping
  ceiling. Profiles allow at most 2,048 entries, 32 dictionary dimensions and four
  full-product references per entry. IDs/labels/native strings have explicit limits.
- New evidence fetches have a 20-second total response deadline and at most 12 pages
  per connection. The SDK abstraction does not expose request cancellation here;
  an already-issued RPC may finish after the response deadline. No shared data cache
  is introduced. The storefront reuses its already-fetched variant snapshot.
- Preview identity fields are bounded before lookups. Existing preview/photo abuse
  guards and delivery credit settlement remain intact. Whole multipart-body parsing
  remains the existing implementation, with the existing decoded photo size limit;
  a stricter streamed multipart envelope is separate hardening work.
- Reference downloads still permit only HTTPS `cdn.shopify.com`, no user info/port,
  no redirects, bounded bytes/pixels and existing in-memory image normalization.
- Active popups watch native form changes and poll for silent ID changes every
  750 ms while open; both listener and timer are removed on close. In-flight obsolete
  results are not acknowledged. Abandoned jobs expire through the existing lifecycle.
- Authorization uses the verified configuration snapshot at generation entry.
  Merchant/provider edits do not retroactively revoke a job already authorized and
  running. Stronger mid-job server revocation is separate work; test these races in
  staging and pause affected products before replacing approval data during a rollout.
- Before disabling the opt-in flag or rolling back to a native-only version after
  manual profiles have been used, pause affected products through their existing
  manual OFF control. Flag-off deliberately restores legacy native operation and
  does not read persisted provider selections. Do not present it as an automatic
  per-product rollback procedure.
- Do not drop the new table as an automatic rollback. Review retention of merchant
  mappings and revisions separately. No database deletion was performed here.

## Required real-store validation

Use authorized staging/admin access to validate the actual provider source and
complete native product data. Verify exact selected size, fabric, colour, headboard,
storage, all composite suffix meanings and media appearance; test sold-out cases,
unsupported/current unmapped variants, profile changes during generation, all
templates, mobile/desktop keyboard interaction, themes with dynamic variant forms,
delivery/expiry/credits, and Add to Cart/checkout non-interference. Source metadata
and synthetic fixtures do not prove visual accuracy of merchant-approved images.

## Scoped installation enablement

See [customization-installation-enablement.md](customization-installation-enablement.md).
The master rollout flag remains required. Configure `TRYORA_CUSTOMIZATION_PROVIDERS_SHOPS`
before enabling it for a restricted rollout. Empty denies all; unset retains the existing
global opt-in behavior for backward compatibility. The list is server-only and is checked
against the authenticated installation, never a submitted shop value.
