# Customization architecture and staged delivery

This records the earlier native-discovery increment. The next implemented provider
foundation and remaining activation gates are in `customization-integration-report.md`
and `customization-provider-setup.md`.

## Priorities

1. Keep discovery, merchant intent and preview authorization separate. Discovery
   proposes a native name; saved exact names remain identities. It never supplies
   missing inventory, repairs stale names or overrides manual OFF/no-selector settings.
2. Keep the server authoritative for variant availability, all selected native
   options, frozen merchant constraints and full-product image references. Swatch
   samples do not authorize generation.
3. Make uncertain states visible to merchants before implementing external sources.
   Missing native data is not proof of a single style. A saved no-selector setting
   authorizes the existing reference preview, not external customization support.
4. Integrate external providers only after authenticated, product-scoped evidence
   and a supported server-side data contract are verified.

## This increment

`native-option-discovery.ts` is the shared source for bounded English aliases.
It tolerates case, spaces, hyphens/underscores, a trailing colon, and choose/select
prefixes. Recognized roles include Fabric/Fabric Type/Upholstery Fabric,
Colour/Color/Fabric Colour/Upholstery Colour, and Finish/Wood Finish.
Material, Shade, translated labels and arbitrary substring matches are deliberately
not interpreted. Merchants can still explicitly select other native option names.

Discovery prefers a unique colour role, then fabric, then finish, independent of
option ordering. Multiple aliases for the same role are ambiguous and are never
resolved by choosing the first. Auto-enable retains existing non-null mappings,
including stale mappings, for review. Manual configurations retain their existing
early-return protection. No configuration is rewritten by admin diagnostics.

Auto-enable and admin recommendations use the same policy as dependent selectors.
The server blocks stale mappings and ambiguous mapped appearance roles; automatic
ambiguous null mappings cannot silently become single-style previews. Explicit
manual null mappings retain the reference-only path. Enabled blocked mappings show
Needs attention in the admin instead of Live; OFF products remain Off.

The existing dependent UI, real swatches, text fallback, mobile/desktop layout,
selected-size binding and in-memory result isolation are preserved. Missing client
matches and server-rejected combinations now get a useful configuration message,
with no automatic substitution or checkout change.

## Adapter boundary (design only)

`packages/core/src/customization-adapter.ts` defines the future server-side port:

- A scope always contains shop and product IDs; any future cache key must include
  both IDs, provider identity and revision. No shared mutable discovery cache exists.
- Authenticated credentials are server-owned context, never client payloads.
- Discovery returns unsupported or a verified, versioned snapshot of actual
  combinations, native variant IDs and provider/merchant swatches.
- Validation must independently fetch current authoritative data and check scope,
  revision, all selected options, availability and approved full-product references.
  An approved result requires a nonempty reference list. A snapshot or type assertion
  is not runtime authorization; each adapter needs implementation and contract tests.
- Native Shopify queries and the existing resolver remain the only implemented
  source. No external adapter, registry, endpoint, scope or integration is enabled.
  `verified_external` is a future contract value, not a supported capability claim.

Do not replace the working native resolver with a large adapter framework before
there is a verified second source. The contract records the required invariants
without adding network calls, dependencies or abstractions to the hot path.

## Verification and remaining work

Regression tests cover bounded aliases, alias ambiguity, exact stale identities,
manual intent and OFF settings, discovery ordering, combinations, stock, variant
changes, missing references and ignored external data. Existing tests continue to
exercise credits, delivery, generation and native size/configuration preservation.
Core runtime files have synchronized app copies for shopify-app-only deployments.

Real-store validation remains required for Aria/Aspen and other merchants:

1. Read-only authorized native product/options/variants/media and saved Tryora settings.
2. Identify the actual external/theme provider, its schema, permissions, dependency
   rules and reliable current-selection mechanism. Never infer these from a catalogue.
3. Verify native variant images actually depict the assigned combination. Shopify
   image assignment is metadata; code cannot prove visual accuracy or prevent a
   merchant assigning the same inappropriate image to multiple variants.
4. Check desktop/mobile and keyboard behavior in actual merchant themes, including
   dynamic product-form variant updates and stale/unknown variant IDs.
5. Define a merchant-approved mapping for custom/localized native names and then
   provider-specific contract tests before activating any external adapter.

This increment does not certify products as globally single-style: native-only
evidence cannot establish absence of external controls. It also does not add
translations, parse combined labels, import global swatch catalogues, or expand
database permissions. No migration, production-data mutation or deployment is needed.
