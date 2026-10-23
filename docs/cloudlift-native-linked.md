# Cloudlift native-linked integration (Tryora)

**Status:** Implemented as an opt-in, merchant-reviewed native-variant bridge. NOT a general Cloudlift catalogue/API integration. Requires staging activation and real-store testing. Nothing here establishes support for Cloudlift-only custom properties.

## Verified public behavior

Cloudlift Live Product Options documents `option:changed` and `options:rendered` events. The former exposes `e.detail.name` and `e.detail.value`, and both bubble to `window`. These are browser notifications, not trustworthy authorization or a complete catalogue:
- https://docs.cloudlift.app/article/181-javascript-events-options

Cloudlift's **Variant options** mode presents genuine Shopify product variants and can change the swatch presentation; the underlying native option values are not editable through that mode:
- https://docs.cloudlift.app/article/101-how-can-i-setup-variant-options

Cloudlift's independent custom options/conditional values need a separately verified authorized product configuration source and exact image links:
- https://docs.cloudlift.app/article/79-how-can-i-setup-custom-product-options

## Implementation

- New provider `cloudlift` may be activated **only per product** via a complete merchant-reviewed native Shopify mapping. Cloudlift store-wide defaults cannot bypass product mapping requirements.
- The mapping JSON uses the existing strict `providerId: "manual_mapping"` schema; the **saved provider selection** is `cloudlift`. This is deliberate: Cloudlift native-linked mode reuses the mature exact Shopify variant/media validation; do not change JSON providerId to cloudlift.
- The admin verifies every exact native option tuple, Shopify variant ID, `availableForSale`, preservation dimensions, and owned approved product media ID before activation.
- The backend re-reads live Shopify variant/media data and validates the active revision, selected source and target variant, fixed size/storage/headboard, and approved full-product reference **before** creating a job or reserving credits.
- The popup listens to `option:changed` only when open and the Cloudlift native-linked provider is active, invalidates old results/jobs on every change, and checks that named native option events agree with the actual selected Shopify variant. Unknown/custom option events disable generation in this popup until page reload; no incorrect colour preview is shown. Event payloads cannot provide images, prices, inventory, or authorization.
- Listeners and timers are removed on popup close. Product/cart selections are **never** modified by Tryora.

## Avelor Beds setup needed

1. Confirm whether Aspen/Aria fabric and colour choices are *Shopify-native variants shown through Cloudlift* or **independent Cloudlift custom properties**. They can coexist.
2. Obtain the actual full Shopify product JSON including native option names, **all** variant tuples, native variant IDs and full-product Shopify media IDs; do not parse or guess composite text.
3. Identify the Cloudlift option names and determine whether its events are native names or independent custom names on the live theme.
4. In staging, set `TRYORA_CUSTOMIZATION_PROVIDERS_ENABLED=true` **only after the reviewed CustomizationConfig database rollout**. Open Tryora admin > Customization providers > product override > Cloudlift native-linked mapping.
5. Use the exact Shopify option/evidence inspector to create a reviewed mapping, with complete preservation fields (size, storage, headboard). Profiles contain full-product `MediaImage` IDs, not swatch samples as reference images.
6. Activate a **single test product**. Inspect popup on a real Cloudlift-enabled theme and test stock, unsupported custom options, dynamic native variant updates, prior result invalidation, image accuracy and credit settlement.
7. If Cloudlift options are not native-linked, **do not activate this provider**. Ask Cloudlift for a documented authenticated configuration and media mapping export/API or use only verified manual mapping where native products genuinely correspond to each colour.

## Explicit limitations

- No Cloudlift authenticated private API, automatic catalogue discovery, independent property support, third-party image-library downloading, or image fabrication.
- Only exact native-linked configurations with reviewed product-owned full-product images can generate. This bridge does not guarantee Aspen/Aria support without merchant data.
- Browser changes that happen before Tryora opens are not an authoritative event history. Only the current native form selection is available without provider-side authenticated state; no custom-property authorization is attempted.
- Existing strict mapping revision + server credit checks remain authoritative. The feature branch has not been tested against a real Avelor storefront.
- The provider feature flag and SQL migration from the full customization branch need separate staging/production review. Do not merge this branch into the native-only release or production main directly.
