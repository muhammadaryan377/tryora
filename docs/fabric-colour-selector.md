# Fabric and colour selector

Historical initial investigation. The merchant subsequently identified Cloudlift;
authenticated catalogue/reference coverage is still unverified. See
`customization-integration-report.md` for the implemented opt-in provider foundation.

## Investigation (23 October 2026)

Reported products:

- Aria: https://avelorbeds.co.uk/products/aria-bed
- Aspen (handle supplied by the owner, not independently verified): https://avelorbeds.co.uk/products/aspen-bed

The public storefront, Aspen URL and swatch page redirect to the store password page.
The public `/products.json?limit=1` feed returns HTTP 401. Aria could not be fetched.
No connected browser session was available to inspect an authenticated product page.
Consequently, the provider of Avelor's dependent fabric/colour, headboard and storage
controls **has not been identified**. It may be theme code or a product-options app;
the evidence does not justify naming an app or assuming these controls are variants.

The previous Tryora implementation selects one native option matching colour, fabric
or finish. It never reads app-owned customization data. Its selector copy calls every
value a colour even when the option contains upholstery fabric names.

## Supported data and behavior

The existing authenticated Admin GraphQL queries already supply native product
options, option-value swatches, and paginated variants with selected options and
assigned product images. No new scopes, database fields or migrations are needed.
See Shopify's [product data model](https://shopify.dev/docs/apps/build/product-merchandising/products-and-collections/add-data).

- Separate native Fabric and Colour/Color options enable Fabric → Colour selection
  when one of them is the merchant-configured visual option. Option names can also
  be `Choose Fabric`, `Fabric Type`, or `Choose Colour`.
- Only fabric/colour pairs present in actual variants are offered. No Cartesian
  product, name-based colour inference, or general fabric catalogue is used.
- Shopify option-value swatch images are displayed as merchant-provided colour
  samples. A shared colour-option swatch is not claimed to be a fabric-specific
  texture. Missing images retain accessible text labels. Existing single-option
  merchant-approved swatch filling remains unchanged.
- Size and every other native option are captured from the current product-form
  variant, with Liquid's selected options as a fallback only when no live variant
  ID exists. Unknown live IDs or ambiguous matches block selection. Unsupported
  combinations never fall back to another size, headboard, storage choice or fabric.
- Fabric and colour form a distinct internal selection key; identical colour names
  in different fabrics never share a generated result. Reopening after a native
  configuration change clears cached results. A running job retains its original
  selection.
- Generation revalidates availability, native options, frozen merchant context and
  existing per-option variant restrictions before reserving credits. Dependent
  requests must specify the exact variant. Product references come from that
  variant's assigned image, or an exact combination VisualChoice approval bound
  to that variant ID. A fabric-wide approval, generic product photo or swatch
  sample is never a substitute for a dependent combination's product reference.
- The AI receives the selected native configuration as bounded product context.
  The image remains the appearance reference; missing product references fail
  before generation or credit reservation.
- Fabric-only products keep the existing reference-based preview. Common fabric
  names supplied under a native option called Colour are labelled Fabric, without
  inventing a colour picker. Single-style products keep their existing path and
  now also send the selected native variant when available.

## Avelor blocker and requirements for a product-options adapter

This change does **not** claim to enable Avelor's external colour choices. An
authenticated product-page/app-configuration inspection is still required to
identify the provider and verify the Aria/Aspen handles. Do not infer product
availability from the store-wide swatch page or cached search results.

If colours are external properties rather than native options, a supported adapter
needs a merchant-authorized, stable data source that supplies:

1. Product-scoped fabric/colour IDs and their actual dependency/availability rules.
2. The merchant's exact swatch image URLs and accessible names.
3. A reliable way to read the current size, headboard, storage and other relevant
   option IDs without writing to the product form or changing checkout behavior.
4. Merchant-approved full-product media for each supported combination, bound to
   the appropriate native variant/configuration. A fabric sample alone is not a
   full-product reference and is insufficient to generate a different upholstery.
5. Server-side revalidation of this mapping; untrusted browser labels or arbitrary
   image URLs are not an approval source.

Until that evidence is available, third-party options are not offered or claimed
to be reproduced in the preview. No checkout, cart, production database, deployment
or remote Git changes are part of this implementation.

## Validation

Regression coverage lives in `shopify-app/test/customization.test.ts`,
`shopify-app/test/popup.test.ts`, and `shopify-app/test/storefront.test.ts`.
Run `npm test`, `npm run typecheck`, and `npm run build` from the repository root.
The build regenerates the tracked theme-extension `tryora.js` bundle.
