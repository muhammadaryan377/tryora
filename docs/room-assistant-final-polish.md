# Room Assistant: approved final appearance-focused design

Worktree: `C:/Users/malik/Downloads/tryora-assistant-v2` (confirmed by the user).
Branch: `feat/room-assistant-final-polish`; base `4b92963`, preserving the merged fabric manager and its approved admin layout.

## Implemented behavior

- Recommendation cards render actual server-verified Shopify product images, title and store-currency price/range. Each shows one short merchant/catalogue-grounded appearance reason. No purchase/preview status badges or size tags are rendered.
- The primary row is View details / Preview in my room. View details uses the exact verified Shopify URL, including the selected native variant where applicable; it does not start a support-chat flow. Compact selection/appearance controls remain available for authoritative follow-ups.
- The welcome preview card now opens the assistant's own photo screen, rather than invoking the popup handoff. Photo selection, appearance refinement, email gates, generation progress, results and Download use the existing in-chat flow and secure preview endpoints.
- The original standalone storefront launcher still opens its original popup and displays its own result there. Legacy handoff result validation remains tested for stale epochs, wrong products, duplicate deliveries and forgotten rooms, but the welcome card no longer launches that handoff.
- Fabric/colour controls remain dependent on verified variant data. Established native size/configuration stays in internal selections and request payloads. An authenticated current-page source can seed its exact existing variant; this never picks another variant.
- Clicking Preview records that exact card as the selected product for later conversational follow-ups.
- Size controls, size tags and sizing prompts are removed from the assistant's normal appearance journey. If required hidden configuration is unknown, generation remains blocked with a neutral configuration message. The client does not pick a size or collapse ambiguous variants into an arbitrary appearance match.
- A newly attached room photo takes precedence over the previous room for preview; obsolete room observations are cleared, and unreferenced old object URLs are revoked. Existing conversation photo ownership and Forget room cleanup remain intact.
- Room observations remain in a compact indicator with Edit and Forget room. The composer remains outside the scrolling messages, with a mobile safe-area inset. Drawer, mobile and fullscreen cards use the same responsive layout.
- Model instructions focus on visible colour coordination, fabric, style and lighting. They request concise responses and up to three relevant verified cards, never invented products, prices or references. Explicit shopper constraints and internal identity validation remain authoritative.

## Preservation and limits

No generator, checkout mutation, credit settlement change, schema/migration, startup change, additional Shopify scope or new external adapter was introduced. Full-product reference validation, live availability, exact source matching, tenant isolation, email enforcement, credit reservation/delivery acknowledgement and memory-only photos are retained.

Independent external options and legacy provider configurations without verified in-chat source/reference support remain blocked inside chat. They are not silently redirected to the popup or treated as native variants. Existing standalone provider previews remain supported through their existing path. Merchant-reviewed mappings and actual-store validation are still necessary; hiding size UI does not authorize a new configuration.

## Regression verification

- Root npm test: **75 core + 505 application tests passed (580 total)**; 31 skipped in the standard run.
- Explicit desktop/mobile browser suites: **21 passed** (15 assistant, 4 popup, 2 admin). These execute 21 of the standard skipped cases; the other 10 live/paid/database opt-in tests were not activated.
- npm run typecheck, production build and git diff --check: passed. The generated extension bundle was rebuilt from source.
- A final targeted UI rerun covers explicit Preview selection becoming authoritative for follow-ups.
- Two image-processing fixture timeouts occurred while the full suite and Chrome were competing for resources. The complete suite passed when run sequentially, with assertions and timeouts unchanged.
- No new Shopify operation or schema was added. Local types/build/browser validation were used; the previously rejected external source-upload validator was not retried. Browser tests use isolated synthetic Shopify data, images and a deterministic streaming model. No real merchant mutation, paid AI generation or production database operation is involved.

Coverage includes room-photo recommendations, actual catalogue product/price/image identities, exact View details navigation, drawer/mobile/fullscreen bounds, appearance-only controls with preserved native configuration, ambiguous hidden choices, in-chat email/progress/result/Download, standalone popup independence, unavailable references, mapped variants, privacy and credit acknowledgement.

Screenshots are local ignored artifacts under `tools/storefront-harness/shots/room-assistant-final-polish/`:

- `final-polish-1280-recommendations.png`
- `final-polish-390-recommendations.png`
- `final-polish-fullscreen-recommendations.png`
- `approved-1280-preview-in-chat.png` and mobile counterpart
- `handoff-1280-chat-result.png` and mobile counterpart (legacy filenames; this now exercises the chat-only welcome journey)
- `handoff-1280-original-popup-result.png` and mobile counterpart
- `10-email-step.png`, `11-preview-after-email.png`

No push, merge, deployment or Shopify release was performed.

## Changed files

- `packages/storefront/src/assistant/drawer.ts`: card layout, chat-only welcome, room editing, hidden configuration and selection state.
- `shopify-app/app/room-assistant.server.ts`: appearance-focused instructions and honest in-chat eligibility wording.
- `shopify-app/app/assistant/options.server.ts`: unsupported-configuration wording only; adapter/variant authorization unchanged.
- `shopify-app/extensions/tryora-theme/assets/tryora.css`: card proportions, actions, compact room indicator, responsive composer.
- `shopify-app/extensions/tryora-theme/assets/tryora.js`: regenerated bundle.
- `shopify-app/test/assistant-browser.e2e.test.ts`: approved journey, independent popup, real product/price/link and responsive screenshots.
- `shopify-app/test/room-assistant-ui.test.ts`: hidden configuration, concise cards, exact selection and legacy delivery guards.
- `shopify-app/test/assistant-journey.test.ts` and `shopify-app/test/room-assistant.test.ts`: updated wording expectations, retaining rejection assertions.
- This report.
