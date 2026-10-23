# Composite native options: data requirements and implementation plan

Status: proposal, pending complete product data. No parser, adapter or production
configuration has been implemented. The examples reported in chat are truncated;
their separators and suffix semantics are not a verified grammar.

## Evidence and inspection boundary

The merchant reports Aspen has native options named `1. Choose Your Size`,
`2. Choose Your Fabric`, and `Other bed choices`. The latter includes values
beginning with fabric/colour text. The reported size groups contain 36 variants
each (180 total). Those counts are an audit expectation, not proof that every
fabric/colour/configuration combination exists or is available.

No product CSV/JSON export was present in this workspace, and no connected Shopify
Admin browser or Shopify connector was available during this investigation. Full
values, exact variant IDs, swatch provenance, image assignments and suffix semantics
remain unverified. No production credentials or session databases were accessed.

Current native discovery does not parse composite option values. Its bounded alias
normalization also does not remove numeric prefixes such as `2.`. A saved exact
fabric mapping can work independently of auto-discovery; do not assume a numbered
name is currently auto-recognized. Explicit merchant option-role mapping addresses
both issues without introducing store-specific shared discovery rules.

## Required complete source data

Prefer a read-only authenticated Admin product export containing:

- Shop domain, product GID/handle and all exact option names and complete values.
- Every variant GID, its complete selectedOptions tuple, assigned image/media
  identity and URL, and `availableForSale`. Read every page and check completeness.
- Product media IDs/URLs and existing Tryora configuration/VisualChoice approvals.
- Product-specific swatch images and their verified fabric/colour associations,
  including the source of those associations.

A merchant product CSV is sufficient to inspect label structure if it includes all
variant rows, full option names/values and assigned images. Check quoting, embedded
delimiters, blank cells and image-only rows rather than treating every CSV row as a
variant. If exact IDs or live availability are absent, reconcile each full option
tuple to authenticated native variant data before activation. Never join by SKU,
display title, row order or a truncated label alone. CSV inventory counts do not
authorize availability; generation must check live Shopify `availableForSale`.

Verify the reported five size groups and 180 unique IDs/option tuples. Report any
discrepancy; do not create missing rows to satisfy those counts.

## Proposed reusable mapping contract

Use a versioned `native_composite` mapping profile, scoped to shop + product. It is
an explicit native-variant projection, not an external provider integration.

| Field | Meaning |
| --- | --- |
| schemaVersion / mappingRevision | Mapping format and approved revision |
| scope | Exact shop and product IDs |
| optionRoles | Merchant-selected exact native names for size, fabric, composite field and any other preserved native fields |
| sourceRevision | Reviewed snapshot fingerprint of option names, full values, variant IDs and option tuples |
| entries | Lookup records for complete, exact composite values; never prefix/substring matches |
| entry.nativeValue | Entire original composite string, preserved byte-for-byte after transport decoding |
| entry.fabric / entry.colour | Merchant-reviewed stable IDs and human labels, not guesses from a label prefix |
| entry.preservedDimensions | Reviewed headboard/storage/other non-appearance settings actually present in the full data |
| entry.configurationGroup | Merchant-approved equivalence group for the preserved dimensions across appearance choices |
| entry.variantBindings | Exact variant IDs and their complete native selectedOptions tuples |
| entry.swatch | Optional verified sample image source and association with this fabric/colour |
| entry.references | Full-product media approvals bound to the exact supported variant/configuration |
| approval | Review provenance and activation state; imported suggestions start inactive |

Shared code must not include the reported store/product names, fabric lists or
option-role assignments. A reusable merchant template may propose the same role
names for multiple products, but each product requires independent native binding
and conflict validation. No mutable cross-store mapping cache; future cache keys
include shop, product, provider/profile identity and mapping revision.

Default to an exact lookup table, not merchant-supplied executable code or arbitrary
regular expressions. A future parser may only propose inactive lookup entries
after a full, verified grammar exists; it must not authorize preview combinations.

## Non-appearance preservation is mandatory

Changing colour necessarily changes the raw composite native option value. Simply
freezing the old raw value would block every change; simply ignoring it would risk
changing headboard, storage or other choices hidden in the suffix.

Therefore expose a candidate only when it:

1. Exists as an actual product variant, with an approved exact mapping binding.
2. Matches the selected size and every other fixed native option exactly.
3. Matches every reviewed non-appearance dimension and configurationGroup from the
   current composite selection, while allowing only the requested fabric/colour change.
4. Agrees with the separate native fabric option, if one is present.
5. Has live `availableForSale` and an appropriate full-product reference.

If suffix meaning or cross-value equivalence is unknown, do not assign an inferred
group or enable colour switching. Offer only the exact current variant as
photographed when its reference is verified. Never silently select the first
candidate when multiple variants match. Unknown live variant IDs, unreviewed
values, missing dimensions or conflicting fabric evidence block the mapped preview.

Swatch samples are independent assets. Do not crop, synthesize or recolour product
images into samples. A missing swatch uses accessible text; a missing product
reference blocks generation. A variant image assignment still needs merchant
verification that it depicts the selected appearance and relevant configuration.

## Implementation stages after data review

1. **Read-only audit:** inspect the full export, enumerate distinct composite values,
   compare fabric evidence, record suffix fields, duplicates and image coverage.
   Produce a review table with no automatic activation.
2. **Pure validator:** validate merchant profile scope/revision, exact native bindings,
   conflicts, fabric agreement, preserved dimensions and media provenance. Return
   structured diagnostics for missing, ambiguous, conflicting and stale entries.
3. **Native projection:** extend the current native path with an explicit opt-in
   composite profile. Keep original variant IDs and selectedOptions untouched;
   add normalized display dimensions separately. Preserve ordinary native and
   manual no-selector behavior without changing global discovery heuristics.
4. **Admin review:** show full values, parsed/mapped display fields, native tuple,
   swatches, product references and blockers. Activation requires merchant review;
   new/changed values remain blocked until reviewed. Storage choice requires a
   separate design review; this plan neither adds fields nor runs a migration.
5. **Selector UI:** show Fabric → Colour from actual mapped candidates. Keep the
   current size/configuration group fixed. Show configuration labels and explain
   when a requested combination has no supported variant/reference. Use a stable
   opaque combination key including profile revision, preserved dimensions and
   variant identity so cached results cannot cross configurations.
6. **Server authorization:** independently load the scoped profile and current
   Shopify variant data, verify exact ID/options/revision, all merchant constraints,
   live availability and approved references before provider calls/credit reservation.
   Browser labels, URLs or submitted configuration groups are not authoritative.
   Existing credit, idempotency, delivery and checkout behavior stay unchanged.
7. **Real-store validation:** review all bindings, test actual dynamic variant forms,
   keyboard/mobile selectors and image correctness before enabling a product profile.

## Regression acceptance matrix

These tests are planned, not claimed as completed parser coverage. The merchant
data-derived fixtures cannot be authored faithfully until complete values arrive.
Synthetic fixtures should additionally test the following invariants:

| Fixture | Required result |
| --- | --- |
| Valid reviewed values across multiple sizes | Exact variant and all native options retained; no Cartesian combinations |
| Same colour text under different fabrics | Separate keys, samples and product references |
| Ambiguous one-value-to-two-colour mapping | Reject; require merchant correction |
| Missing lookup or truncated input | Reject; no prefix/fuzzy fallback |
| Composite fabric conflicts with separate native fabric | Reject |
| Duplicate variant binding or duplicate option tuple with competing IDs | Reject ambiguity rather than choose first |
| Same fabric/colour with different headboard/storage suffix | Preserve dimensions; block switching without verified equivalence |
| Unknown suffix or omitted preservation dimension | No mapped colour switching |
| Native option renamed or value changed | Stale revision; require review |
| Variant removed or ID now bound to different options | Reject before provider/credits |
| Admin inventory count disagrees with availableForSale | Use live availableForSale only |
| Swatch missing but approved full-product reference exists | Accessible text fallback; valid exact preview |
| Product reference missing but swatch exists | Reject generation |
| Cross-shop/product profile or unverified image URL | Reject |
| Explicit manual OFF/no-selector product | Preserve merchant intent and existing reference-only flow |

Run the full tests, typecheck and build after implementation. The current runtime
remains unchanged while this plan awaits complete product data and review.
