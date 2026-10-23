# Room Assistant 2.0

The Room Assistant is an opt-in storefront chat for Shopify furniture merchants. Shoppers open a right-side drawer, ask about the store's real products and policies, attach a room photo, get verified recommendations, and preview eligible products in their room without leaving the conversation. The existing "See it in your room" product popup is unchanged and works alongside it.

## Merchant controls

The assistant is disabled by default. Merchants configure it in **Tryora > Room assistant**:

- page visibility (product, collection, home, other), plus exact product and collection exclusions. Exclusions control where the launcher appears; they do not hide products from search.
- greeting, launcher label, launcher side (left or right) and accent colour.
- **Assistant opens as**: side panel (default) or fullscreen. Shoppers can switch at any time, and phones always use fullscreen.
- **Store notes**: up to 8,000 characters of merchant-written facts (delivery areas, lead times, showroom, warranty) that the assistant may quote.

Settings live in the existing `Appearance.copy.assistant` JSON. 2.0 adds `defaultView` with a safe default, so settings saved earlier load unchanged. There are no Prisma models, migrations or scope changes.

> **Fixed in 2.0:** the settings form had no submitted field for *Store notes*, so every save stored empty notes. A regression test now checks that every setting has a form field.

## Provider configuration

```env
OPENAI_API_KEY=...
OPENAI_ASSISTANT_MODEL=gpt-4.1-mini           # optional
OPENAI_ASSISTANT_PRIVACY_ACKNOWLEDGED=true
TRYORA_ASSISTANT_TRANSPORT=poll               # optional: "sse" only after verifying on a real store (see Streaming)
```

Every model call uses the Responses API with `store: false` and `stream: true`. The API key is only used on the server.

## Shopper experience

- **Launcher:** a compact pill with a chat-and-sparkle icon and the merchant's label and colour. It has a subtle entrance and hover animation and full keyboard support (`aria-haspopup="dialog"`, `aria-expanded`). It shows a dot while a conversation is waiting (red for an unread reply). It stacks above a floating "See it in your room" button on the same side, and above Shopify Inbox or similar chat bubbles.
- **Drawer:** 440px wide, anchored to the right with the page still visible and usable. The header has *Conversation options* (New chat, Clear conversation, Forget room), *Minimise*, *Expand to fullscreen / Restore side panel* and *Close*. Minimising or switching modes never loses the conversation, and a running answer or preview keeps going. Only fullscreen is modal (it traps focus and locks page scroll). Escape closes menus, then minimises.
- **Mobile (≤749px):** full-screen with safe-area padding. The header and composer stay fixed and only the conversation scrolls. Controls are touch-sized and there is no horizontal overflow (verified in a real browser at 390×844).
- **Welcome screen:** *Visualise in my room*, *Find furniture for my room* and *Ask about products*, all real actions, plus suggestion chips. On a preview-enabled product page, *Use product preview instead* opens the existing popup.
- **Composer:** a ＋ menu with *Upload photo* and *Take photo* (camera, shown on touch devices). The photo appears as a thumbnail with Replace and Remove, with validation and preparation errors and upload progress (percentage while sending). Enter sends, and Shift+Enter starts a new line.
- **Answers:** status steps ("Analysing your room…", "Searching store products…", "Checking variants and availability…", "Preparing recommendations…"), then the model's text appears as it is generated. Stop cancels on the server too; Retry re-sends the same question once. Model text is escaped; only bold, bullets and paragraphs are rendered.
- **Cards:** image, options, verified price, *Available to buy* or *Currently sold out*, AI preview status, the reason, *View product*, and *See it in my room* only when the exact variant passes Tryora's preview checks.
- Motion is subtle, and `prefers-reduced-motion` disables it.

## Conversation history

| Kept | Where | Limits |
|---|---|---|
| Messages, cards, preview offers, room observations, stated preferences, selected product | `sessionStorage` key `tryora_assistant_v2:<shop>` | 4 h idle or 24 h total; ~100 KB and 60 entries (oldest dropped first) |
| Room photo and generated preview images | In-memory object URLs only | Gone on reload; the transcript then shows "not kept after the page reloads" |

- History follows the shopper across pages and refreshes in the same tab, and the drawer reopens if it was open. It is not shared with other tabs and is never sent to Tryora's database, Shopify or analytics.
- Each message sends a bounded slice to the server: the last 12 completed turns, up to 6 numbered recommendations, the selected product, room observations and preferences. The server re-validates every reference against fresh Shopify data.
- The key and stored shop are checked on load, so one store's context can't appear in another. The v1 shared key `tryora_assistant_context` is deleted.
- **New chat** clears messages, recommendations and preferences but keeps the room. **Forget room** removes the room notes and photo but keeps messages. **Clear conversation** removes everything.
- This is browser-side history. OpenAI requests still use `store: false`.

## Streaming

**Default transport: long-polling a server-side turn buffer**

1. `POST /apps/tryora/assistant/turn` starts the turn and returns `turnId`. A newer question from the same visitor aborts their previous turn.
2. The server runs the agent loop and appends events: `status`, `delta` (real model output deltas from the streamed Responses API), `reset_text`, `recommendations`, `visualise`, `room`, `preferences`, then `final` (the authoritative message) and `done`, `error` or `cancelled`.
3. `GET /apps/tryora/assistant/turn/<id>?visitor=&after=n` returns new events as soon as they exist, waiting up to 8 s. Text therefore arrives incrementally even if Shopify's app proxy buffers each response.
4. `POST …/turn/<id>/cancel` aborts the model call.

Buffers are bounded (3,000 events, 512 KB), bound to shop and visitor, expire 3 minutes after a turn ends, and hold no photos. Turn IDs carry the worker ID, so with `TRYORA_WORKER_ORIGINS` configured, reads are routed to the instance that owns the turn. The client reconnects through short network drops and resumes from the last event.

**Optional SSE transport (`TRYORA_ASSISTANT_TRANSPORT=sse`)**

`POST /apps/tryora/assistant/stream` returns `text/event-stream` (2 KB padding, `X-Accel-Buffering: no`, keep-alives). If the stream breaks, the browser continues the same turn by polling, without duplicates.

**What was verified, and what wasn't**

- Real Chrome against a local HTTP server running the real turn handlers: long-poll delivered at least 3 partial answer states over more than 750 ms before the final text, and SSE delivered at least 4 incremental states over one real chunked HTTP response.
- **Not verified:** whether Shopify's app proxy forwards SSE chunks unbuffered. That needs a real store, which is why SSE is off by default. Long-polling doesn't depend on it.

**Safety of streamed text**

Recommendations are only shown as cards that the server has verified, and they arrive before the prose. The final message replaces the streamed draft, and any price the server never returned (and the shopper never typed) is removed from it. Stock and preview status appear only on cards.

## Agent and tools

Tools are read-only and allowlisted, with argument validation:

- `search_products`
- `get_product_details`
- `search_store_info`
- `list_collections`
- `recommend_products` (verified cards)
- `request_visualisation` (preview offer, strict eligibility)
- `record_room_observations` (only when a photo is attached)
- `update_shopper_context` (budget, colours, materials, sizes, room dimensions)

Limits per request: up to 4 tool rounds (the first must call a tool), then a forced answer; at most 8 tool calls and 12 model-driven Shopify calls; 60 s budget, 30 s per model call, and one retry only before any text has streamed.

If Shopify fails, tools return `store_data_temporarily_unavailable` with an instruction not to claim the store has no matching products.

Catalogue awareness, search (synonyms, BM25, constraints, live Shopify fallback) and store knowledge are unchanged from 1.x; see `app/assistant/catalogue.server.ts`, `text.ts` and `knowledge.server.ts`.

## Previews inside the conversation

A *See it in my room* or *Generate preview* button appears only when the server's strict check passed for that exact variant. That check is the same `loadProviderSetting` → adapter → `resolveConfiguredPreview` chain that `startPreview` uses. Cloudlift and manual-mapping products show "choose options on the product page" instead.

Generation calls the existing `/apps/tryora/preview` → `/preview/<job>` → `/ack` endpoints with the exact product, variant and option value. The server therefore re-applies every existing check: reference images, photo analysis, quotas, lead capture and credits. Following the popup's rule, the acknowledgement that consumes a credit is sent only after the image is displayed. If the store requires an email before previews, the chat hands off to the product page popup (`#tryora`).

Refinements such as "Show it in cream" or "Try another option" are new verified requests. Placement can't be steered: the instructions forbid promising exact positions, moving furniture, or colours that aren't real variants.

## Privacy and security

- Room photos are compressed in the browser (max 1600px), sent only with the message they're attached to, normalised on the server for that request, and never stored or logged.
- Logs are structured and allowlisted (`app/assistant/log.server.ts`): no message text, photos, visitor IDs or API keys.
- The proxy enforces request size limits (history 30 KB, photo 8 MB) and the existing visitor, shop and concurrency rate limits.
- Chat never consumes credits.

## Tests

| Suite | Covers |
|---|---|
| `test/room-assistant.test.ts` | Settings compatibility and form fields, validation, grounding, fresh re-checks, visualisation eligibility (sold out, unconfigured, Cloudlift), preferences, streaming deltas and reset, price sanitisation, cancellation, multi-turn references, room continuity, bounded rounds, Shopify outage, rate limits |
| `test/assistant-turns.test.ts` | Turn buffers (wake-up, isolation, supersede, bounds), request limits, incremental long-poll before completion, Stop, SSE, worker routing |
| `test/room-assistant-ui.test.ts` (happy-dom) | Launcher, drawer modes, minimise and restore, keyboard, welcome actions, attachments, upload progress, streaming render, XSS safety, cards, in-chat preview and acknowledgement, lead hand-off, Stop and Retry, errors, New chat / Forget room / Clear, history across reloads, expiry and cross-store isolation, blocked storage |
| `test/storefront-boot.test.ts` | Preview and assistant launchers coexisting, merchant placement, independent failure |
| `test/assistant-browser.e2e.test.ts` | Real Chrome: everything above end to end, plus desktop and mobile layout. Run with `TRYORA_E2E=1` (optionally `TRYORA_E2E_BROWSER`, `TRYORA_E2E_SCREENSHOTS`) |

## Release checklist (test store first)

1. Re-run `npm test`, `npm run typecheck`, `npm run build`, `git diff --check` and the browser suite (`TRYORA_E2E=1`).
2. Deploy the app server to a **staging** environment with `TRYORA_ASSISTANT_TRANSPORT` unset (poll).
3. `shopify app deploy` the theme extension to a **development store** only, and enable the Tryora app embed.
4. In the development store, enable the assistant for product pages and add test Store notes. Confirm the notes persist after saving.
5. Verify on desktop and a real phone:
   - launcher placement next to the product preview button and any chat widget
   - a text question streams
   - a photo question records the room
   - a follow-up uses it
   - a verified card generates an in-chat preview and uses exactly one credit
   - Stop, Retry, New chat, Clear and Forget room work
   - refresh keeps history
6. Check the new Admin queries (`TryoraAssistantCatalogue`, `…ProductDetail`, `…StoreInfo`, `…Pages`) succeed against the real store and watch `room-assistant` logs for `shopify_failure`.
7. Optional: set `TRYORA_ASSISTANT_TRANSPORT=sse` on staging and confirm in browser devtools that `/apps/tryora/assistant/stream` events arrive incrementally through the app proxy. If they arrive all at once, keep `poll`.
8. Only then consider a production release and merchant enablement.

The storefront bundle `shopify-app/extensions/tryora-theme/assets/tryora.js` is generated by `npm run build` and must not be edited by hand.
