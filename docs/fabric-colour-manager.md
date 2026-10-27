# Fabric & Colour Manager - two configuration modes

24 October 2026. Branch `feat/fabric-colour-manager`, based on clean `0edf065`.
The approved AI Live Chat Previewer commits and all existing native/Cloudlift safeguards are retained.

## Merchant workflow

Products and app navigation link to **Fabrics & Colours**. The page loads actual Shopify products in bounded pages, then complete variant/media evidence for the selected product. It exposes exactly two manager modes:

1. **Shopify Native - Automatic** reads actual native option names/aliases, numbered fabric/colour names, native image/HEX swatches, complete exact variants and `availableForSale`. Missing swatches stay text labels. Refresh reads Shopify again and displays the fetch time. Saving this mode does not alter Shopify product data, repair an explicit option mapping, change ON/OFF, or discard a previously saved manual draft. Explicit manager Native mode does not mix in legacy name-based colour guesses.
2. **Manual Setup - Merchant Managed** has Fabric, Colours and Mapping steps. Create/edit/disable/remove fabrics; manage each fabric's own named colours, actual samples and optional HEX. Same-name colours under separate fabrics retain distinct sample identities. Editing a fabric/colour name clears its binding review. Removing a Visully item removes its bindings from the draft, never Shopify variants/media. Save publishes only enabled, reviewed, exact, valid bindings. Unbound samples remain visibly unready and cannot authorize generation.

The existing advanced provider settings route remains available to inspect existing installations. It is not a third manager mode or a new provider integration. Existing Cloudlift native-linked adapter identity is preserved when an existing Cloudlift profile is explicitly saved through Manual Setup.

## Storage and publication

No Prisma model, SQL migration, startup script or database setup change is required. The existing opt-in `CustomizationConfig` row stores a scoped, versioned `fabric_colour_manager` JSON document containing the editable draft and a validated `ManualMapping` publication. `providerId` persists Native/Manual selection; a new opaque revision guards every update. Native switching preserves the existing saved manual document. Reads and writes are scoped by authenticated shop and verified product; submitted shop identities are never authority.

Drafts contain labels, descriptions, enabled flags, Shopify media IDs, native variant IDs, exact native options, reviewed preserved dimensions and optional external option values. They contain no image bytes, image URLs, credentials or AI-generated samples. Published mappings must agree with their draft's enabled fabric/colour, identities, full native tuple, preserved fields, separate approved references and review flag. Duplicate variants/tuples, conflicting composites, wrong ownership, missing media and stale values fail closed.

Texture/swatch media IDs cannot also be approved full-product references. The merchant must review whether a full-product photo actually depicts the exact appearance/configuration. The server verifies product ownership, tuple identity, source/target preservation, availability, mapping revision and media resolution again before generation through the existing adapter chain.

Manual setup uses the **existing** provider-table rollout gate, `TRYORA_CUSTOMIZATION_PROVIDERS_ENABLED`. The code does not enable it. When OFF, the new page performs no provider-table reads/writes and native previews continue through the existing path. Save controls explain the installation prerequisite.

## Merchant media uploads and scopes

Still JPG/PNG/WebP images up to 8 MB / 24 MP are decoded in memory, normalized and stripped of metadata. Multipart bodies are bounded before parsing. The server accepts upload destinations only from authenticated Shopify staged-upload responses, rejects redirects, and attaches the resulting image to the verified product. Pending Shopify processing is reported for refresh/reuse, not interpreted as a usable reference.

Images stay in Shopify product media, using the existing `write_products` access. Uploads therefore add images to the product's media/gallery; this is disclosed beside the controls. Removing/replacing a Visully sample never deletes Shopify media because other configurations can reuse it. There is no filesystem/image-byte database storage, new object-storage service, automatic scraping, provider credential entry or new requested scope.

The new operations were checked against Admin API **2026-07**: [stagedUploadsCreate](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/stagedUploadsCreate) and [productUpdate](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/productUpdate). The latter documents `write_products` and adds media independently of product-variant mutations. Permissions/user errors remain explicit; no automatic scope escalation or checkout/variant write is performed.

## Shared shopper behavior

The original popup and Room Assistant use the same verified manager projection: real fabric textures, per-fabric colours, separate sample/HEX metadata and approved full-product references. Unready/disabled combinations never acquire synthetic variant IDs. Empty/fully disabled manual catalogues do not expose a working preview launcher. Swatch-only drafts may show disabled choices where the existing product is preview enabled.

The assistant options model preserves every exact native option and reviewed preservation dimension. Fabric switching clears only its dependent colour, retains size/other options and disables preview while a combination is incomplete. Managed in-chat requests send the current mapping revision and exact source variant through the existing `/preview` endpoint. A captured product-page source change blocks the request; a stale revision, missing source, unavailable target or changed preservation group is rejected on the server before credit reservation. Current-page natural requests without an established source retain the product-page handoff rather than inventing one.

Standalone popup results stay in their popup. Assistant-initiated popup results and inline chat previews stay in the conversation, with existing email checks, delivery acknowledgement and credit settlement. Legacy manual/Cloudlift profiles retain their original product-page source-selection behavior. No separate generator was added.

## Validation and screenshots

Final checks on this implementation:

- Root `npm test`: **75 core + 500 app tests passed**; **29 app tests skipped** in the standard run.
- Explicit browser run with `TRYORA_E2E=1`: **19 passed** across manager, popup and assistant suites. This executes the 19 browser cases skipped by the standard run. The remaining 10 paid/live-store/isolated-database opt-in cases were not activated.
- Root `npm run typecheck`: passed in every workspace.
- Root `npm run build`: passed; the generated theme `tryora.js` was rebuilt from source.
- `git diff --check`: passed.
- Shopify API 2026-07 operations, Polaris App Home component and theme JS/CSS asset validation passed during implementation. A further repeat external schema/asset validation call was rejected by automatic approval review because it could transmit proprietary code and the prompt; that repeat call did not execute. All final local checks and browser regressions completed.

Browser fixtures render the actual React manager with the official Polaris runtime and exercise real route actions against isolated Shopify/Prisma fakes. Their product/sample images and AI responses are synthetic; they are not live Avelor verification.

Local screenshots, inspected on desktop and mobile, are under `tools/storefront-harness/shots/fabric-colour-manager/` (ignored generated artifacts):

- `manager-native-1280.png` and `manager-native-390.png`: Shopify Native mode.
- `manager-manual-colours-1280.png` and `manager-manual-colours-390.png`: Manual Setup colour management.
- `manager-mapping-1280.png` and `manager-mapping-390.png`: exact native/reference mapping.
- `manager-customer-selector-1280.png` and `manager-customer-selector-390.png`: customer Fabric -> Colour selector.

Manual labels and samples are available in the shared selectors. Text catalogue search still reads Shopify-native catalogue evidence; this patch does not add a separate search index for merchant-created appearance names.

## Release and rollback - instructions only

- No deployment, production migration, production write or push is part of this task. This patch adds no schema migration. Review the installation's pre-existing provider-table rollout independently before opting in.
- Record the currently deployed backend/extension revisions and back up affected products' existing scoped configuration JSON through approved admin tooling before enabling merchant use. Release a matching reviewed backend and rebuilt extension; do not combine different selector/backend revisions.
- Staging must verify real merchant-owned image uploads/processing, exact native/composite source and target tuples, size/headboard/storage preservation, references, availability, manual OFF, email gates, credit settlement, desktop/mobile and real camera permissions. Full-product photographic suitability requires merchant review; no model can infer approval from an arbitrary swatch or HEX.
- Older backends do not understand the new JSON envelope and will reject active new manual documents. Prefer rollback to a version that understands this format. If an older rollback is essential, use a reviewed, product-scoped revision-checked conversion to the document's validated legacy publication (and keep the full draft backup), or restore the recorded prior product configuration. Do not run blind SQL, drop tables, delete media, silently fall back to another variant or disable provider safeguards as a shortcut.
- Legacy profiles with conflicting per-variant sample assignments or unsupported identities must be reviewed in existing integration settings before manager import; they are never silently collapsed or overwritten. Independent third-party options remain unpreviewable without a verified supported native-linked variant/reference. Exact external option values can be retained as draft evidence; they do not create checkout integration or preview authorization. No new automatic external adapter is claimed.

## Changed files

- `docs/fabric-colour-manager.md`
- `packages/storefront/src/assistant/drawer.ts`
- `packages/storefront/src/assistant/options.ts`
- `packages/storefront/src/assistant/preview.ts`
- `packages/storefront/src/assistant/session.ts`
- `packages/storefront/src/main.ts`
- `shopify-app/app/assistant/options.server.ts`
- `shopify-app/app/components/fabric-colour-manager.tsx`
- `shopify-app/app/customization/fabric-manager.server.ts`
- `shopify-app/app/customization/fabric-manager.ts`
- `shopify-app/app/customization/fabric-media.server.ts`
- `shopify-app/app/customization/option-model.ts`
- `shopify-app/app/customization/validation.server.ts`
- `shopify-app/app/room-assistant.server.ts`
- `shopify-app/app/routes/app.fabrics.tsx`
- `shopify-app/app/routes/app.products.tsx`
- `shopify-app/app/routes/app.tsx`
- `shopify-app/app/routes/proxy.$.tsx`
- `shopify-app/app/storefront.server.ts`
- `shopify-app/extensions/tryora-theme/assets/tryora.css`
- `shopify-app/extensions/tryora-theme/assets/tryora.js`
- `shopify-app/test/fabric-manager-assistant.test.ts`
- `shopify-app/test/fabric-manager-browser.e2e.test.ts`
- `shopify-app/test/fabric-manager.test.ts`
- `shopify-app/test/popup-browser.e2e.test.ts`
- `shopify-app/test/room-assistant-ui.test.ts`
