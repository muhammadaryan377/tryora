# Isolated staging test: Room Assistant on test-sofa-site

Branch: `feat/assistant-product-images`. Target store: `test-sofa-site.myshopify.com` (password-protected development store).

This runs a **separate "Tryora Staging" app** from a developer machine with `shopify app dev`. It does not touch:

- the production Shopify app or its `shopify.app.toml`
- the Railway deployment or the production database
- the Avelor Beds store

`shopify app dev` serves a development preview of the theme extension to the chosen store only and **creates no app version**. Nothing is deployed or released.

## Access required

| Who | Access |
|---|---|
| Shopify Partner organisation member | Permission to create an app ("Tryora Staging") in the Partner Dashboard |
| Staff or collaborator on `test-sofa-site` | Install apps, edit themes (duplicate theme only), view the storefront password |
| Developer machine | Node 20+, this repository, `npx shopify` CLI login to the Partner organisation, a **separate** PostgreSQL database |
| OpenAI | A staging API key (chat). Image previews can stay on `IMAGE_PROVIDER=mock` to avoid cost |
| Optional | A read-only Admin API token (`read_products`) from a custom app on `test-sofa-site`, for the scripted live verifier |

## 1. Create the staging app (one time)

1. In the Partner Dashboard, create a new app named **Tryora Staging**. Do not copy the production client ID anywhere.
2. Configure it from a clean checkout of the branch:

   ```powershell
   git clone <repo> tryora-staging; cd tryora-staging; git switch feat/assistant-product-images
   cd shopify-app
   Copy-Item shopify.app.staging.toml.example shopify.app.staging.toml
   # Set client_id to the Tryora Staging app's client ID (or: npx shopify app config link, choose Tryora Staging).
   ```

   The template keeps production's scopes and uses its own app proxy, `/apps/tryora-staging`, so it can't collide with a production Tryora install on the same store.

## 2. Staging database (isolated)

```powershell
createdb -U postgres tryora_staging
$env:DATABASE_URL = "postgresql://postgres:<password>@localhost:5432/tryora_staging"
npm ci; npx prisma generate
npx prisma migrate deploy   # this throwaway staging database only; never against production
```

## 3. Build the storefront for the staging proxy

From the repository root, in the staging checkout only (this rewrites `tryora.js` in that checkout; do not commit it):

```powershell
$env:TRYORA_PROXY_PATH = "/apps/tryora-staging"
npm ci; npm run build -w @tryora/storefront   # prints: built tryora.js (/apps/tryora-staging)
```

## 4. Run the staging app against test-sofa-site

```powershell
cd shopify-app
$env:OPENAI_API_KEY = "<staging key>"
$env:OPENAI_ASSISTANT_PRIVACY_ACKNOWLEDGED = "true"
$env:OPENAI_ASSISTANT_MODEL = "gpt-4.1-mini"
$env:IMAGE_PROVIDER = "mock"                 # "openai" only if you intend to test real image generation
Remove-Item Env:TRYORA_ASSISTANT_TRANSPORT -ErrorAction SilentlyContinue   # default long-poll transport
npx shopify app dev --config staging --store test-sofa-site.myshopify.com
```

Confirm the CLI says it is using **Tryora Staging** before continuing. Open the install link it prints and install the app on `test-sofa-site` only.

## 5. Theme setup (duplicate theme only)

1. **Online Store › Themes**: duplicate the live theme as "Tryora staging".
2. In the duplicate, **Customize › App embeds**: enable **Tryora** from *Tryora Staging*. If the production Tryora embed is present, disable it **in the duplicate only**.
3. Test through **Preview** of the duplicate theme. The live theme is untouched.

## 6. Configure the assistant (staging admin)

In **Apps › Tryora Staging › Room assistant**:
- enable it for product and home pages
- optionally add Store notes
- click Save, then reload and confirm the notes persisted

To test in-chat previews, set up AI preview on one bed (for example Egerie) in the staging app's product setup.

## 7. Catalogue diagnostics

Open **Room assistant › Check catalogue connection**, or `/app/assistant-diagnostics?q=bed&handle=<egerie handle>`.

| Check | Expected on test-sofa-site |
|---|---|
| App permissions | ✓ includes `write_products` |
| Shopify product counts | ✓ active and total counts shown |
| Assistant catalogue query | ✓ first page lists the active products as **published and usable**, with "N have no onlineStoreUrl but a publishedAt date (expected while the store is password-protected); they are included". **Record the requested and actual query cost** (expected requested cost ≤ 587) |
| Product search | ✓ "bed" finds Chelsea Luxe Bed, Thames Bed Frame, Egerie Curved Headboard Beige Boucle Bed, Monaco Panelled Bed |
| Product lookup (Egerie) | ✓ "status ACTIVE, published to the Online Store at … (no onlineStoreUrl, as on password-protected stores), link /products/…", variant count and availability |

Repeat with `q=sofa` and with each bed's handle.

## 8. End-to-end chat (duplicate theme preview)

On the Egerie product page:

| Ask | Expected |
|---|---|
| "Show me available beds" | Status steps, then streamed text and up to 3 cards. Each card shows the **real Shopify image**, title, price in GBP, *Available to buy* or *Sold out*, *View product* (opens `/products/<handle>`), and *See it in my room* only for a preview-verified variant |
| "How many beds do you sell?" | 4 (via `count_products`), never inferred from the cards |
| "Do you have the Egerie in another fabric or size?" | Exact variants. Each card shows that variant's own photo, the approved preview reference, or the featured photo labelled "Product photo" with the note |
| Upload a room photo, then "Which bed would suit this room?" | "Using your room: …" chip, then cards. A follow-up does not re-upload the photo |
| Select a preview-verified card → *See it in my room* | Preview appears in chat, and exactly one credit is used (check Tryora Home / usage) |
| Turn off Wi-Fi mid-answer, then Retry | Clear error, and Retry re-sends once |
| Refresh the page | Conversation restored, and the drawer reopens |

Also check that the existing *See it in your room* launcher still appears on preview-enabled product pages, and that both launchers stack without overlapping (desktop and phone).

## 9. Optional scripted live verifier (read-only)

```powershell
cd shopify-app
$env:TRYORA_VERIFY_SHOP = "test-sofa-site.myshopify.com"
$env:TRYORA_VERIFY_TOKEN = "<read_products Admin API token>"
$env:TRYORA_VERIFY_HANDLE = "<egerie handle>"
$env:TRYORA_VERIFY_REPORT = "verify.json"
$env:TRYORA_VERIFY_CHAT = "1"   # optional; uses OPENAI_API_KEY
npx vitest run test/assistant-live-store.verify.test.ts --reporter=verbose
```

`verify.json` records Shopify's requested and actual cost for every query, the diagnostics, the four beds with their real images, Egerie's variants with their own images and availability, and the chat replies.

## Pass criteria

Every diagnostics check is ✓, the catalogue query's requested cost is under 1,000 with no Shopify errors, all four beds are found and counted, cards show real images and correct links, and no reply claims the store has no beds.

## Teardown

1. Stop `shopify app dev` (Ctrl+C). The development preview is removed.
2. Uninstall **Tryora Staging** from `test-sofa-site`.
3. Delete the "Tryora staging" duplicate theme.
4. Run `dropdb -U postgres tryora_staging`.
5. Delete the read-only custom app token, if one was created.
