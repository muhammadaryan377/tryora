# Selector discovery audit — commit 2856735

23 October 2026. Audit and synthetic regression fixtures only; no runtime change
or additional integration has been implemented.

## Confirmed code-level causes

1. `app/auto-products.server.ts` discovers the first native option whose name
   matches `/colou?r|fabric|finish/i`. With no matching name it saves a null
   `visualOptionName`. Furniture eligibility checks product status, category and
   presence of a product photo; it does not establish customization coverage.
2. Manual configurations return unchanged from `ensureAutoProductConfig`, including
   a deliberate null or stale visual-option name. `productRows` also uses a saved
   null rather than discovering an option again. Saving product settings sets
   `autoConfigured: false`, so subsequent auto-discovery does not override it.
3. `app/routes/app.products.tsx` renders `visualOptionName ?? "Single style"`.
   This is a fallback label, not a verified inventory assertion. The product editor
   separately offers an explicit "None – single style" setting.
4. `packages/core/src/customization.ts` uses an exact match for the configured
   option. Outside the dependent path it creates choices only when that option
   has more than one value. Null, a stale name, or a one-value fabric option
   therefore yields no choices even if a separate external colour control exists.
5. Dependent discovery recognizes Fabric/Fabric Type/Choose Fabric and
   Colour/Color/Choose Colour, case-insensitively. Both must be present and the
   configured visual option must match one. Other names (including translations,
   "Upholstery Shade", and combined fabric-colour strings) have no dependency
   parser. Broad auto-discovery and narrow dependent recognition are distinct.
6. `storefrontConfig` builds swatches only from those native selections.
   The popup initializes `__single__` and hides swatches when the list is empty.
   The popup does not literally render "Single style"; that text is in the admin.
7. The auto-product, storefront and preview queries do not retrieve customization
   metafields, metaobjects, third-party option definitions or theme settings.
   `native-selection.server.ts` validates native variants and existing VisualChoice
   restrictions; it is not an external-data discovery layer.

These explain reproducible missing-selector paths. They do **not** identify which
path affects Aria, Aspen or any other live Avelor product.

## Supported cases and remaining gaps

| Product data | Current behavior | Additional work |
| --- | --- | --- |
| Separate native Fabric + Colour, configured to either | Dependent choices from real variant pairs | No integration required for recognized names |
| Only native Fabric, multiple values | Fabric selector; no invented colour list | External source needed if colours exist elsewhere |
| One native fabric value + external colours | No native swatches; single-style flow | Coverage/status distinction and external adapter |
| Size-only native variants + external colours | No colour selector; exact size can still be previewed as photographed | Product-specific external mapping |
| Multiple native sizes + fabrics | Fabric selection retains native size; absent combinations unavailable | No integration for native-only preview |
| Missing combination-specific product image | Selector can remain visible, but generation rejects missing reference | Merchant-approved full-product media tied to exact combination/variant |
| Genuine single style | Existing exact-variant/reference preview | None |
| Native colours but saved null/stale option | Selector absent; stale name rejects at generation | Diagnose configuration; preserve manual intent |
| Nonstandard/localized option names | Auto-discovery may miss them; dependency recognition may fail | Explicit merchant mapping, not guessed semantics |

Important safety limit: missing native colours does not prove that a product has
one style. An exact native variant photo is evidence for an **as-photographed**
preview, not evidence that an external Cream/Velvet/headboard selection is represented.
The current resolver ignores external fields; it cannot validate or reproduce an
external configuration. No live assertion of such coverage should be made.

Native dependent generation already checks stock, option pairs, frozen context,
variant IDs and merchant restrictions. It refuses generic or fabric-wide images
as fallback for dependent combinations, and never uses a swatch as a full-product
reference. Shared native colour swatches are samples, not proof of a fabric-specific
product appearance. Swatch images and product references are separate concerns.

## Metafields and third-party systems

Colour data could be stored in merchant-owned metafields, referenced metaobjects,
theme settings, an app's backend, or app-private data. Merely adding a generic
metafields query does not supply dependency semantics, current selections, stock,
or an approved reference mapping. Access must be verified for the actual owner and
namespace/key/type. Shopify documents [metafield definitions and access control](https://shopify.dev/docs/apps/build/metafields/definitions)
and [installation-owned data](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/AppInstallation).
An app's installation data is not automatically readable by another app.

No Shopify connector or connected browser session was exposed during this audit.
No authenticated Admin API session was established, and no production database,
session-token store or secrets were accessed to obtain one. The earlier public-store
password blocker remains documented in `fabric-colour-selector.md`; the live
store's option provider and affected-product configuration remain unverified.

Needed for a read-only live diagnosis:

- Authorized Admin/product-editor access or redacted exports for affected product
  IDs/handles, native options/variants/media, plus saved Tryora settings
  (`autoConfigured`, `visualOptionName`, frozen context and VisualChoices).
- The actual theme/options-app name and a rendered product-page inspection showing
  current selections and how controls map to native variants or external properties.
- If custom data is involved: exact namespace/key/type, definitions, readable values
  and referenced IDs; otherwise the provider's supported API/export and permissions.
- Product-scoped fabric-to-colour rules, real swatch URLs, configuration constraints
  and approved full-product photos bound to supported combinations and native IDs.

No credential sharing is required in a report; use an authorized connected session
or redacted product/configuration exports.

## Smallest safe next code change (proposal, not implemented)

Introduce an explicit discovery status shared by server configuration and admin UI:
`native_choices`, `configured_single_reference`, `unconfigured`, and
`stale_option_mapping`. An empty native choice list alone must not certify a genuine
single style. Report unsupported/external coverage only when merchant/provider
evidence establishes it; absence of native data means coverage is unknown.

First replace the misleading admin fallback with "No preview option configured"
for a null mapping, and surface stale option mappings for merchant correction.
Keep an intentional manual single-reference setting and the existing credit/reference
checks intact. The existing schema does not distinguish every historical null's
intent, so do not automatically re-enable or remap those products.

After that, use explicit per-store option mapping for native naming differences.
Implement a provider adapter only after the source, access and product-reference
contract above are verified. Do not scrape a global swatch catalogue or infer a
Cartesian fabric/colour inventory.

## Regression verification

`shopify-app/test/fixtures/selector-audit.ts` contains six synthetic payloads matching
the requested cases. `shopify-app/test/selector-audit.test.ts` characterizes discovery,
rejects fabricated external colours and wrong variants, checks size restrictions,
rejects missing product photos, preserves true single-style previews, and reproduces
null/stale mappings. These fixtures are not live merchant data and cannot identify
the Avelor provider. Existing popup/generation/auto-enable regression tests remain
part of the full suite.
