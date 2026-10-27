# Room Assistant 2.0

The Room Assistant is an opt-in storefront chat for Shopify furniture merchants. Shoppers open a right-side drawer, ask about the store's real products and policies, attach a room photo, get verified recommendations, and preview eligible products in their room without leaving the conversation. The existing "See it in your room" product popup is unchanged and works alongside it.

## Merchant controls

The assistant is disabled by default. Merchants configure it in **Visully > Room assistant**:

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
- **Cards:** image, options, verified price, *Available to buy* or *Currently sold out*, AI preview status, the reason, *View product*, and *See it in my room* only when the exact variant passes Visully's preview checks.
- Motion is subtle, and `prefers-reduced-motion` disables it.

## Conversation history

| Kept | Where | Limits |
|---|---|---|
| Messages, cards, preview offers, room observations, stated preferences, selected product | `sessionStorage` key `tryora_assistant_v2:<shop>` | 4 h idle or 24 h total; ~100 KB and 60 entries (oldest dropped first) |
| Room photo, uploaded thumbnails, original-vs-generated comparisons and generated previews | In-memory object URLs plus same-tab scoped IndexedDB Blobs on the Shopify browser origin | Browser-local only, best effort, 4-hour expiry; unavailable in blocked/private storage; no server-side image history |

- History and available local images follow the shopper across pages and refreshes in the same tab. Only the legitimate Shopify app proxy receives photos for the requested analysis/generation; no chat images are uploaded for persistence to Visully's database, Shopify Files or analytics. Same-origin storefront scripts can access IndexedDB like other origin-scoped web storage; browser storage is not a substitute for customer-facing long-term image hosting.
- Each message sends a bounded slice to the server: the last 12 completed turns, up to 6 numbered recommendations, the selected product, room observations and preferences. The server re-validates every reference against fresh Shopify data.
- The key and stored shop are checked on load, so one store's context can't appear in another. The v1 shared key `tryora_assistant_context` is deleted.
- **New chat** clears messages, cached previews and preferences but keeps the current room. **Forget room** removes room notes, current photo and original comparison photos but keeps messages and already generated previews. **Clear conversation** revokes object URLs and deletes this tab/shop's local images. An expiry sweep purges stale browser cache entries on assistant launch.
- This is browser-side history. OpenAI requests still use `store: false`.

## Streaming

**Default transport: long-polling a server-side turn buffer**

1. `POST /apps/visully/assistant/turn` starts the turn and returns `turnId`. A newer question from the same visitor aborts their previous turn.
2. The server runs the agent loop and appends events: `status`, `delta` (real model output deltas from the streamed Responses API), `reset_text`, `recommendations`, `visualise`, `room`, `preferences`, then `final` (the authoritative message) and `done`, `error` or `cancelled`.
3. `GET /apps/visully/assistant/turn/<id>?visitor=&after=n` returns new events as soon as they exist, waiting up to 8 s. Text therefore arrives incrementally even if Shopify's app proxy buffers each response.
4. `POST …/turn/<id>/cancel` aborts the model call.

Buffers are bounded (3,000 events, 512 KB), bound to shop and visitor, expire 3 minutes after a turn ends, and hold no photos. Turn IDs carry the worker ID, so with `TRYORA_WORKER_ORIGINS` configured, reads are routed to the instance that owns the turn. The client reconnects through short network drops and resumes from the last event.

**Optional SSE transport (`TRYORA_ASSISTANT_TRANSPORT=sse`)**

`POST /apps/visully/assistant/stream` returns `text/event-stream` (2 KB padding, `X-Accel-Buffering: no`, keep-alives). If the stream breaks, the browser continues the same turn by polling, without duplicates.

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

## Catalogue grounding and the October 2026 incident

**Incident:** on `test-sofa-site.myshopify.com`, a shopper viewing the *Egerie Curved Headboard Beige Boucle Bed* was told "This store currently does not have any beds available for sale".

**Root cause:** the catalogue index and live-search query asked for 20 products × 20 variants (with images), 4 collections and 10 metafields per page. That is a requested cost of **1,782**, and Shopify rejects any query above 1,000 (`MAX_COST_EXCEEDED`) before running it. Every product search failed, the model saw no products, and it invented an absence claim. The simulated Shopify used in tests did not enforce query cost, so this was not caught.

**Fixes:**
- **Cheaper query:** the index query now asks for 15 products × a 5-variant sample without images (cost about 590). Exact variants and images come from the per-product detail query (cost 329). `test/assistant-grounding.test.ts` asserts every assistant query stays at or below 80% of the limit. The fixture now rejects over-cost queries exactly like Shopify, and the previous query is shown to fail.
- **Current product:** the product the shopper is viewing is read fresh at the start of each turn. It is given to the model as verified context and stays searchable even if the catalogue is down.
- **Counts:** `count_products` answers "how many" and "do you sell any" questions. It counts across the complete index when one is loaded, otherwise uses Shopify `productsCount`; it never infers totals from a capped search page.
- **Honest empty results:** if nothing meets every filter, search returns related products of the requested kind (for example a sold-out bed) and says the store does sell them. "None" is only reported as verified after a complete catalogue check.
- **Absence guard:** any final-message sentence claiming the store has none of a product kind is replaced unless a complete check proved it. The replacement says the range could not be verified and mentions the viewed product. Policy sentences such as "no delivery charge" are left alone.
- **Logging:** Shopify failures are logged with Shopify's own error code (`MAX_COST_EXCEEDED`, `ACCESS_DENIED`, `THROTTLED`) and the requested cost when Shopify reports it.

**Real-store verification:** in the Shopify admin, open **Visully › Room assistant › Check catalogue connection** (`/app/assistant-diagnostics?q=bed&handle=<product-handle>`). This read-only page runs the assistant's own queries against the store and shows:
- the shop and granted scopes
- active and total product counts
- whether the catalogue query succeeds, with Shopify's reported cost
- how many products are published to the Online Store
- what a search returns
- one product's status, publication and variant availability

## Customer journey fixes (branch fix/assistant-customer-journey)

Root causes found for the real-store issues:

| Symptom | Root cause | Fix |
|---|---|---|
| Every in-chat preview showed "this store asks for your email" | The chat always sent `leadDone=0`, while the merchant lead mode defaults to `required` | The chat now applies the merchant's lead mode and timing exactly as the product popup does. It shows one inline email form, submits through the existing `/lead` endpoint (server-validated, consent wording included), then resumes the pending preview. "After" timing allows the first preview, then asks. "Skippable" offers Skip. The email is never stored in the browser |
| Preview disabled or "not offered" for beds whose product page offers it | Chat only read existing ready configurations; the product page auto-configures products on first view | Recommended products go through the same `ensureAutoProductConfig` step (only when the merchant's auto-enable setting is on), then strict validation |
| "Choose options on the product page" for single-variant beds; AI asked about sizes or fabrics that don't exist | The model and cards saw Shopify's placeholder "Title: Default Title"; product-level cards never resolved a variant | Default Title is hidden everywhere. A product with exactly one variant resolves to it automatically, and preview eligibility is still verified server-side |
| Repeated email and room-photo warnings | Each attempt added a new message | Notices are deduplicated, and a second email request reuses the open form. A double click never starts a second job |
| Inconsistent preview messaging | Card and model used different texts | One server-side `previewReason` is shared by card and model |
| Card's preview button stuck on "Creating preview…" after a preview | Only the preview message re-rendered | Cards re-render when a job ends |

Also:
- **Option selector on cards:** "Choose options" or "Change options" opens fabric family chips, circular colour swatches and size, headboard and storage chips. These are built from real Shopify variants (`/apps/visully/assistant/options`). Composite values such as `Plush Velvet: Cream | Headboard: 50 inches | Storage: No Storage` are split for display only when every value shares one exact shape. A selection resolves to exactly one variant and updates price, stock, image and preview eligibility. Preview eligibility per variant comes from `storefrontConfig`, the product page's own model. Cloudlift and manual mappings point to the product page; no provider is enabled automatically.
- **Memory:**
  - `select_product` remembers "I like the first one".
  - `request_visualisation` uses the selected product, including single-variant products with `variantRef: null`.
  - Shopper-stated room facts are saved in preferences as `roomNotes`.
  - Shopper messages older than the 12-turn window are sent as up to 6 short reminders, labelled as shopper statements, not facts.
- **Store-wide signals:** the assistant config now includes the merchant's lead settings and whether preview credits remain. With no credits, preview buttons are disabled with a reason.
- **Attribution:** in-chat previews tag the basket exactly like the popup.
- **Shorter replies:** the model writes one or two sentences when cards are shown, explains room fit without scores, and never asks for an email.

No database schema, API scope, billing or credit-rule changes. Query costs: the detail query with option swatches is 332; the product-page model used by the selector is the existing 761-cost query.

## Conversation state (branch fix/assistant-conversation-state)

QA on `test-sofa-site` (October 2026) found the assistant choosing products from prose instead of state. The causes and fixes:

| Scenario | Root cause | Fix |
|---|---|---|
| A: Cloud Nine chosen on its card, then "select one", and the assistant picked Egerie | Cards had no select action. The "Selected" badge only mirrored the last product the AI touched, and the server passed the selection to the model as a hint | Cards have a **Select** button. Selections carry a `source` (`card`, `options` or `conversation`). The shopper's own choice is authoritative: "select one" confirms it, and `select_product` / `request_visualisation` refuse any other product with `reference_mismatch` |
| B: "$250 budget", then kids beds recommended | The budget persisted only if the model called `update_shopper_context`. There was no notion of a children's product | The server parses the budget and audience from every message (`nextConstraints`) and returns them, and the browser stores them and sends them back. Search applies the budget as `maxPrice` and excludes children's products (title, type, tags or collections) unless the shopper said it is for a child. `recommend_products` drops misfits before the 3-card cap |
| C: "show me tha" previewed Egerie at $319.99 | `request_visualisation` accepted any old conversation selection | An ambiguous reference resolves to the old selection only if that selection still fits the budget and audience. Otherwise the assistant asks one short question, and the tools refuse to guess |
| D: "show me Cloud Nine" only said "preview unavailable" | There was no "show the product" path, and a refusal offered nothing else | `select_product` renders the product's real card (photo, price, View product) labelled *Selected product*. A refused preview still shows that card and offers up to two previewable alternatives that fit the constraints. The reason is said once |
| Cards disagreeing about preview status | Old cards never updated. Auto-configuration failures were indistinguishable from "not eligible" | Older cards for the same exact variant take the newest verified status. Auto-config failures are now logged (`auto_config_failure`, `admin_query_failed`) |

How a reference is resolved, implemented in `app/assistant/references.server.ts`, which is pure and deterministic. The latest message is checked in this order:
1. A product named in the message. Truncated names work ("Cloud Nine U"), and a real name beats colour-only titles.
2. An ordinal ("the second one", "option 3", "the last one"), resolved against the latest cards.
3. "Select one" or "pick for me". Right after a card selection it confirms that card. Otherwise the assistant chooses among products that fit the constraints.
4. "This", "that", "it" and similar. The shopper's card or option selection always wins. A conversation selection wins only while it still fits the latest budget and audience.
5. Otherwise the message is ambiguous, and the assistant asks one short question.

The resolution is written into the developer context as **Authoritative conversation state**, rebuilt from structured data every turn, and the tools enforce it. Explicitly naming an over-budget product is honoured, and the reply states the difference. A page refresh restores everything from `sessionStorage` (`selected` with `source`, and `constraints`). No database, schema, scope or billing changes.

## Previews inside the conversation

A *See it in my room* or *Generate preview* button appears only when the server's strict check passed for that exact variant. That check is the same `loadProviderSetting` → adapter → `resolveConfiguredPreview` chain that `startPreview` uses. Cloudlift and manual-mapping products show "choose options on the product page" instead.

Generation calls the existing `/apps/visully/preview` → `/preview/<job>` → `/ack` endpoints with the exact product, variant and option value. The server therefore re-applies every existing check: reference images, photo analysis, quotas, lead capture and credits. Following the popup's rule, the acknowledgement that consumes a credit is sent only after the image is displayed. If the store requires an email before previews, the chat hands off to the product page popup (`#tryora`).

Refinements such as "Show it in cream" or "Try another option" are new verified requests. Placement can't be steered: the instructions forbid promising exact positions, moving furniture, or colours that aren't real variants.

## Privacy and security

- Room photos are compressed in the browser (max 1600px), sent only for requested analysis/preview, and never stored in the app database or server logs. **For same-tab continuity the browser may temporarily cache compressed source and generated Blobs in its own IndexedDB** (up to 8 MB per item, 4-hour logical expiry, pruned on return). Images are neither saved in localStorage/sessionStorage nor hosted on external media storage. If browser storage is blocked, full, evicted or expired, the assistant still works, but the shopper may need to upload the photo again.
- An in-progress generation resumes by its opaque server job ID after navigation, or by re-posting the **same idempotency key and exact original room** if navigation interrupted job creation. The server still enforces all credit, lead, shop and variant checks. Its transient job expires, so recovery is best effort—not guaranteed if backend restarts or the visitor returns outside the delivery window. Shoppers can minimise the drawer and continue browsing.
- Logs are structured and allowlisted (`app/assistant/log.server.ts`): no message text, photos, visitor IDs or API keys.
- The proxy enforces request size limits (history 30 KB, photo 8 MB) and the existing visitor, shop and concurrency rate limits.
- Chat never consumes credits.

## Tests

| Suite | Covers |
|---|---|
| `test/room-assistant.test.ts` | Settings compatibility and form fields, validation, grounding, fresh re-checks, visualisation eligibility (sold out, unconfigured, Cloudlift), preferences, streaming deltas and reset, price sanitisation, cancellation, multi-turn references, room continuity, bounded rounds, Shopify outage, rate limits |
| `test/assistant-turns.test.ts` | Turn buffers (wake-up, isolation, supersede, bounds), request limits, incremental long-poll before completion, Stop, SSE, worker routing |
| `test/room-assistant-ui.test.ts` (happy-dom) | Launcher, drawer modes, minimise and restore, keyboard, welcome actions, attachments, upload progress, streaming render, XSS safety, cards, in-chat preview and acknowledgement, lead hand-off, Stop and Retry, errors, New chat / Forget room / Clear, history across reloads, expiry and cross-store isolation, blocked storage |
| `test/assistant-references.test.ts`, `test/assistant-conversation-state.test.ts` | Budget, audience and reference resolution. QA scenarios A–D with a scripted model that repeats the real model's mistakes: card authority, budget persistence and enforcement, children's products, ambiguity, named over-budget products, corrections, refresh, forged state, long-conversation staleness |
| `test/storefront-boot.test.ts` | Preview and assistant launchers coexisting, merchant placement, independent failure |
| `test/assistant-browser.e2e.test.ts` | Real Chrome: everything above end to end, plus desktop and mobile layout. Run with `TRYORA_E2E=1` (optionally `TRYORA_E2E_BROWSER`, `TRYORA_E2E_SCREENSHOTS`) |

## Release checklist (test store first)

1. Re-run `npm test`, `npm run typecheck`, `npm run build`, `git diff --check` and the browser suite (`TRYORA_E2E=1`).
2. Deploy the app server to a **staging** environment with `TRYORA_ASSISTANT_TRANSPORT` unset (poll).
3. `shopify app deploy` the theme extension to a **development store** only, and enable the Visully app embed.
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
7. Optional: set `TRYORA_ASSISTANT_TRANSPORT=sse` on staging and confirm in browser devtools that `/apps/visully/assistant/stream` events arrive incrementally through the app proxy. If they arrive all at once, keep `poll`.
8. Only then consider a production release and merchant enablement.

The storefront bundle `shopify-app/extensions/tryora-theme/assets/tryora.js` is generated by `npm run build` and must not be edited by hand.
