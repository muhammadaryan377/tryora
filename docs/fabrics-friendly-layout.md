# Fabrics & Colours layout

The merchant editor now uses the approved two-column layout: a fabric list and a wide colour editor, without a customer-preview card. The page header holds save status and the Save changes button. Colour rows open the existing editor for names, HEX values, uploads, enabled state and removal. Exact variant/reference controls remain accessible in the Advanced settings disclosure.

Swatch appearance is a product-level setting shared by all fabrics on that product. Circle and rectangle shapes support widths of 25, 50, 75 and 100 px. Rectangles are 70% as tall as their width. Changes update the visible admin samples immediately and save through the existing authenticated configuration action. The server validates the optional `draft.swatchAppearance` field in the existing JSON document; no Prisma migration is required. Existing documents without the field retain their legacy storefront styling until the merchant selects an appearance.

The saved setting is passed through the manual storefront configuration and the managed Room Assistant options response. Both clients validate values before building styles. Large samples wrap on desktop; the mobile product popup retains its horizontal scroll. Text-only native fabric options retain their existing rendering.

Uploads, variant/reference checks, merchant authorization, revision checks, disabled choices and product ON/OFF behavior retain their existing semantics. The design shows actual product data; no example fabrics or colours are inserted.

## Validation

- Workspace unit tests, production build and typecheck pass.
- React DOM tests exercise colour/fabric editing, page-save blocking during colour edits, appearance changes, save callbacks and reload.
- Server tests cover appearance persistence, storefront output, legacy documents and rejected invalid settings; the assistant test checks response propagation.
- The desktop/mobile browser suite is updated for the Advanced settings disclosure and appearance save/reload. It could not run here: Chromium exits at launch because the execution environment denies its socket operation. Visual QA in a real embedded Shopify admin remains required.

## Release

Merge the reviewed branch, deploy the backend/admin and release the rebuilt theme extension together. This change updates the extension's generated `tryora.js` and `tryora.css` so existing installed stores need the extension release to display the new shopper swatch settings. No deployment or live merchant write is performed by this change.
