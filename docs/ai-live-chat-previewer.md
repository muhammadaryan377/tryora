# AI Live Chat Previewer - final approved direction

24 October 2026. Branch: `feat/ai-live-chat-previewer`, based on clean `6c6394d`.
Commit `8523620` and the approved Room Assistant/photo/popup handoff implementation remain in the base.

## Final interaction

- Exactly two main welcome cards: Preview this bed in my room, and Recommend a bed for my room. Other verified furniture categories receive appropriate wording; missing product selection receives the existing selection guidance.
- No welcome suggestion chips, FAQ prompts or Ask about products card. The composer stays available for room photos, furniture choices, colour changes and preview requests. Its placeholder is now "Describe your room or ask for a preview...".
- Category and fabric/colour copy is witnessed in this merchant's published native catalogue. Unknown product types use neutral furniture wording; composite/external appearance values stay opaque. No new provider integration or approval is inferred.
- The historical suggestions endpoint now returns an empty suggestions array for older clients, with bounded optional recommendation-card metadata. New clients ignore suggestion arrays altogether. It reuses the existing per-shop cache, without a new Shopify query or AI call.
- The model instructions prioritise room analysis, budget/preferences, up to three verified product recommendations, and natural follow-up previews. Three is the existing supported recommendation limit. Fewer real matches remain preferable to padding the list. Explicit support questions still use verified store knowledge and receive brief answers.
- Existing exact product/variant/reference validation remains authoritative. Available for purchase does not imply preview approval. Room-photo memory, email gates, acknowledgement and credit handling are retained.
- An assistant welcome preview opens its dedicated instance of the existing popup and returns the generated image to the conversation. The original standalone launcher keeps its own popup result. No popup or generation backend changes were needed in this patch.

## Changed files

- `packages/storefront/src/assistant/drawer.ts`: two-action welcome, no chips, grounded recommendation copy, preview-focused heading and composer placeholder. Camera/upload, natural conversation and preview handoff remain intact.
- `shopify-app/app/assistant/suggestions.server.ts` and `app/routes/proxy.$.tsx`: optional catalogue-derived welcome copy and empty legacy suggestions response.
- `shopify-app/app/room-assistant.server.ts`: focused model instructions, preserving tool grounding and authoritative state.
- `shopify-app/app/assistant/text.ts`: own-property guards on synonym dictionaries. A new merchant-category regression exposed a pre-existing crash when ordinary text contained "constructor"; it is now treated as normal text rather than an inherited JavaScript property.
- Tests: `assistant-suggestions`, `assistant-catalogue`, `assistant-grounding`, `room-assistant`, `room-assistant-ui`, and `assistant-browser.e2e`. Existing assertions for current product grounding were updated to require verified context and to reject an invented current selection.
- `shopify-app/extensions/tryora-theme/assets/tryora.js`: regenerated through the root production build, never edited by hand.

## Validation

- `npm test`: 75 core and 457 app tests passed; 27 opt-in tests skipped in the standard run.
- `npm run typecheck`: passed across all workspaces and the app.
- `npm run build`: passed, including storefront asset regeneration and the backend production build.
- Shopify theme tooling: rebuilt `assets/tryora.js` passed validation.
- `TRYORA_E2E=1` browser run: 17 passed in Chrome across desktop/mobile popup and assistant journeys. Welcome, recommendation, preview and standalone-popup screenshots were visually reviewed.
- `git diff --check`: passed.

A new deterministic server journey analyses a synthetic room, returns three real fixture products with EUR prices and genuine fixture product image URLs, then requests the exact second product/colour/size with room, preferences and budget retained. UI tests reject chips even from an older backend, retain the photo/text composer draft, verify correct currency and preserve the no-product guard. Browser tests exercise desktop/mobile photos, three-card recommendations, natural follow-up previews, email capture, exact variants, in-chat downloads, independent standalone popup results and unchanged cart selection.

## Screenshots

Local synthetic-fixture captures are saved under `tools/storefront-harness/shots/ai-live-chat-previewer/` (ignored artifacts). They show the built application UI, not a live merchant catalogue or actual AI-generated image quality.

## Remaining validation and release limits

No authenticated Avelor catalogue, approved composite/Cloudlift swatch mapping or live model/image output was inspected. Real-store staging must still verify the merchant's product/reference approvals, page visibility, camera permissions, policy scopes, model response quality and end-to-end credit settlement. The standard run's opt-in live-store, paid OpenAI and PostgreSQL checks were not activated; browser checks are run separately against isolated synthetic fixtures.

No schema, migrations, startup, checkout, credits, provider authorization, merchant settings or production data were changed. No push, deployment or production database write is authorized by this task. Release the matching backend and extension revision only through the existing review/release process; existing provider-table rollout prerequisites remain independent of this patch.
