# Fabrics & Colours: approved admin layout

Branch: `feat/fabric-manager-approved-layout`, based on `37c3077` (the merged two-mode manager).

The existing manager is refactored in place. No second configuration system, provider, database model or API mutation was added.

## Merchant workflow

- Title and subtitle match the approved design. Product selector, Save changes and Add fabric are grouped at the top.
- Manual Setup presents a fabric sidebar with actual thumbnails, colour counts and selected highlighting. Its selected-fabric editor retains name, description, media upload, enable/disable and safe removal.
- The adjacent colour table exposes swatch, name, HEX, RGB, sample reference image and actions. Add colour creates a draft only. Actual sample selection/upload, replacement, enable/disable and removal use existing controls.
- RGB is an editable representation of the existing persisted HEX value. Saving one canonical value avoids contradictory RGB/HEX records and needs no migration. Missing colour data produces an honest fallback. Invalid RGB shows an error and blocks Save changes until corrected.
- Variant Mapping is visible below both panels, with fabric, colour, exact Shopify variant, approved full-product reference, status and actions. Add mapping creates an unbound draft. Changing fabric or colour clears its old variant/reference and review. No variant is automatically selected.
- Mapped badges require an enabled, reviewed, unique exact live variant tuple, availableForSale, owned references distinct from sample media, and no external-only values. Incomplete/stale/conflicting drafts show Needs mapping. Save and every generation still use authoritative server validation; a badge never authorizes a preview.
- Mapping review, preserved composite dimensions and unsupported external evidence remain accessible in row details. Native role settings are in a compact disclosure. Mappings remain paginated to six rows.
- Native Automatic remains read-only against Shopify product data. Existing manual OFF, installation opt-in, stale mapping warnings and revision guards are unchanged.

Tables scroll within their panels on narrow screens. Fabric cards become a horizontally scrolling list on mobile. The wide Polaris page permits the desktop sidebar/table layout without compressing all columns into the default page width.

The colour table's reference image is a fabric sample. Full-product reference approval stays in Variant Mapping, where it can be bound to exact size/headboard/storage and other native options. Samples alone cannot authorize image generation.

## Files

- `shopify-app/app/components/fabric-colour-manager.tsx`: existing screen layout and controls.
- `shopify-app/app/customization/colour-values.ts`: strict HEX/RGB conversions.
- `shopify-app/test/colour-values.test.ts`: conversion and invalid input regressions.
- `shopify-app/test/fabric-manager-browser.e2e.test.ts`: adapted workflow assertions plus sidebar, RGB, incomplete mapping and responsive coverage.
- This report.

No server resolver, checkout, credits, email, popup or assistant source logic changed. A root build regenerates the extension from its unchanged source. The pre-existing generated-file working change was backed up locally before building; its Git diff contained no content changes.

## Validation

- Root npm test: 75 core + 502 application tests passed (577 total); 29 skipped in the standard run.
- Explicit browser suites: 19 passed across manager, popup and assistant. The final admin-only rerun also passed both desktop/mobile cases, including invalid RGB and incomplete mappings. The remaining 10 live/paid/database opt-in cases were not activated.
- npm run typecheck and npm run build: passed. Generated extension content is unchanged by this admin-only refactor.
- git diff --check: passed.
- Installed Polaris component types verify the wide-page option; no Shopify operation or schema was added. No repeat external code-upload validator was attempted after its earlier automatic approval rejection. Browser fixtures use isolated Shopify/Prisma data and synthetic images, not a live merchant or AI service.

Screenshots: `tools/storefront-harness/shots/fabric-manager-approved-layout/manager-manual-colours-1280.png`, `manager-manual-colours-390.png`, `manager-mapping-1280.png`, `manager-mapping-390.png`, and native-mode counterparts. These generated screenshots are ignored by Git.

No push, deployment, migration, production configuration or production database change. Existing manual-mode rollout prerequisites and real merchant staging validation still apply. Independent third-party options remain draft evidence unless an existing supported exact native-linked mapping is verified.
