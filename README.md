# Tryora

Shopify app: shoppers see a merchant's product in a photo of their own room. Merchant admin, storefront popup,
credits, limits, lead capture and sales tracking are built; real AI images, billing and App Store submission are next.
The full handover (access, what's built, what's left, test plan) is in the owner's "Tryora developer handover" doc.
Product decisions: `TRYORA/docs/decisions.md` (owner's folder).

## Layout
- `packages/core` – engine (credits ledger, jobs, limits, popup flow, swatches). `npm test`.
- `packages/storefront` – popup source, bundled into the theme extension.
- `shopify-app` – the Shopify app (React Router, Polaris web components, Prisma/Postgres).
- `shopify-app/app/core` – GENERATED copy of `packages/core`; never edit. Run `node scripts/sync-core.mjs`.
- `shopify-app/extensions/tryora-theme` – app embed, button block, built `tryora.js` / `tryora.css`.
- `tools/storefront-harness` – local fake store + Playwright screenshots of the popup.
- `tools/model-test` – trying image models.

## Commands
1. `npm install` and `npm test`
2. After changing `packages/core`: `node scripts/sync-core.mjs`
3. After changing the popup: `npm run build -w @tryora/storefront`
4. In `shopify-app`: `npx tsc --noEmit && npm run build` (Railway runs the same build; a failure = failed deploy)
5. In `shopify-app`: `npx shopify app deploy` to release the extension, permissions and webhooks

Pushing to `main` may redeploy the server on Railway (Docker, `shopify-app/Dockerfile`).
Docker builds generate Prisma Client; startup only starts the server. `npm run setup`
also only generates the client. Database creation and schema changes require a separate,
explicitly authorized database operation; development startup does not apply migrations.
See `docs/release-safety-review.md` for release gates and the migration/rollback plan.

## Rules
- Never store shopper photos or generated images. Preview lead contact details (email, optional first name and explicit marketing choice) are retained only in the authenticated merchant lead dashboard; Shopify customer sync is best-effort. Never put contact details in logs or browser storage. See docs/lead-capture-dashboard.md for retention and release details.
- The credits ledger is append-only; a credit is charged only when an image is delivered.
- Don't import `core/index` into browser code (admin page components); it breaks the build.
- New Shopify permissions need the owner's approval.
- `shopify-app/app/routes/app.dev-seed.tsx` is a temporary test-store-only page: remove before launch.

## Fabrics & Colours — isolated sample images (staging candidate)

Fabric textures and colour swatches are **preview-only** assets and must not enter the
Shopify product media/gallery. Newly uploaded `purpose=sample` images use staged
uploads followed by Shopify's `fileCreate` (Shopify Files); only
`purpose=reference` (full furniture photographs) uses `productUpdate(media:)`.

**Scope prerequisite:** Shopify Files requires `write_files` (or `write_images`)
for file creation, and `read_files` for file listing (if used). Request the
merchant/owner's approval before adding new Shopify scopes or deploying an
updated app version. **Do not silently edit production `shopify.app.toml` or
fall back to product-media uploads when file creation is denied.**
Test only with the separate `shopify.app.development.toml`, approved scopes
and a development store first.

Existing sample media previously uploaded through Tryora is still attached to
Shopify products and may still appear in store galleries. The new upload path
does not delete these legacy images or migrate saved IDs automatically. The
merchant must review/migrate active samples and explicitly approve removal of
the obsolete product-media copies before cleaning up their galleries. Changing
an alt tag or hiding a thumbnail using generic theme CSS is not a reliable fix.

The Fabrics & Colours navigation remembers the selected product in a
shop-scoped browser session and defaults to opening an editor on first visit.
A deliberate "Browse more products" link keeps product pagination available.

## OpenAI furniture replacement (local opt-in)

The server-only adapter uses the official `openai` Node SDK and Images Edit API, with
`gpt-image-2` by default. No browser key, Files API uploads or additional database image storage.
The mock remains the default, including automated tests. Never silently fall back to mock on API
failure: the existing job fails and releases its reservation.

Configure these variables in the server environment (`shopify-app/.env` for local app development,
or export them in the shell). The repository root `.env.example` lists the defaults:

- `IMAGE_PROVIDER=mock|openai` (default `mock`)
- `OPENAI_API_KEY` (server secret; only required for `openai`)
- `OPENAI_IMAGE_MODEL=gpt-image-2`
- `OPENAI_IMAGE_PRIVACY_ACKNOWLEDGED=true` only after reviewing the linked data policy and your
  account's controls. This acknowledgement does **not** confirm zero retention.

Do not change Railway variables or deploy as part of local testing.

The existing Shopify resolver chooses an available matching visual option under frozen merchant
options. The first reference is the matching variant photograph, or the merchant-approved photograph
for that choice. Multi-option products without either are refused, rather than using an arbitrary
product colour. The preview currently selects visual options, not a complete storefront variant ID;
merchants must freeze any other options that materially change appearance.
The adapter sends the normalized room as IMAGE 1 and that selected reference as IMAGE 2. Additional
generic references are excluded to avoid conflicting colours. The dedicated prompt preserves the
actual room, belongings, lighting, camera and existing clutter, while replacing only the target.
Only `replace` placement is supported by this adapter; other placements fail without a charge.

Images use existing Sharp validation: max 8 MiB, 24 million decoded pixels, minimum 400x300,
no animation; normalize to JPEG within 1600x1600 and strip metadata. The SDK response stream is
limited to 12 MiB before JSON parsing; output must be one bounded base64 image and decode successfully.
HTTP errors are sanitized, requests have a 150-second timeout and zero automatic SDK retries, inside
the existing three-minute worker deadline. No API errors, prompts, credentials or photo bytes are logged.
The existing reservation, result checks, delivery acknowledgement, deduplication, cancellation,
expiry and refund paths remain in place: only acknowledged delivery consumes one credit.
`costMicros=0` is an **unpriced placeholder**, not a claim that OpenAI requests are free. Do not use
these values to reconcile provider billing; usage-token pricing is deferred.

### Tests

From the repository root:

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
```

Automated adapter tests mock HTTP underneath the official SDK and never spend API credits.
The live smoke test is skipped unless explicitly enabled. To make ONE paid edit, use your own
consented local room and product photos (no automatic download), and a server key in the shell:

```powershell
$env:OPENAI_API_KEY = '<your key>'
$env:OPENAI_IMAGE_PRIVACY_ACKNOWLEDGED = 'true'
$env:OPENAI_IMAGE_MODEL = 'gpt-image-2'
$env:TRYORA_SMOKE_ROOM = 'C:\private\room.jpg'
$env:TRYORA_SMOKE_PRODUCT = 'C:\private\selected-bed.jpg'
$env:TRYORA_OPENAI_SMOKE = '1'
npm.cmd --prefix shopify-app run test:openai-smoke
Remove-Item Env:TRYORA_OPENAI_SMOKE
```

The smoke test validates a real response in memory and saves no output. For visual review, run the
local Shopify app with `IMAGE_PROVIDER=openai`, upload your room via the preview popup, choose the
configured product colour, and inspect the image before accepting delivery. Check that only the
bed changed, the product matches, and the rest of the room remains faithful. Repeat with a failed
request and duplicate delivery acknowledgement to verify credit behaviour. Switch back to
`IMAGE_PROVIDER=mock` afterwards. Review the local development setup above for Shopify prerequisites.

### Limits and extension points

`analyseRoom` and `checkResult` perform structural decoding only. They do not detect furniture,
reject a non-room photograph, score quality or certify exact product fidelity/room preservation.
These remain explicit methods on the existing interface so detection, segmentation and a rejecting
fidelity scorer can be added without changing the ledger. Prompting alone cannot guarantee exact
furniture reproduction or preservation of original room pixels. Visually assess results before a
production rollout. A generated image that passes file checks can still be semantically incorrect.

Mask investigation: OpenAI documents that a mask applies to the **first** image when several are
provided. It needs an alpha channel and matching source dimensions/format. A future mask must match
the normalized customer room, with transparent pixels marking the edit area, never the product.
Masks are guidance and cannot guarantee unchanged pixels outside the region. This release does not
expose a mask input (`supportsMaskedEdit=false`) or add segmentation dependencies. Future strict
pixel preservation would require segmentation, compositing and independent output validation.

OpenAI data controls can retain abuse-monitoring content by default; zero retention requires account
eligibility/approval and has exceptions. The capability remains `zeroRetentionConfirmed=false`.
Review your privacy notice and actual account configuration before enabling customer photos.
Concurrent jobs and their transient storage still use the application's existing worker limits;
load-test memory and paid API throughput before enabling at scale.

Official references verified for this implementation:
- https://developers.openai.com/api/docs/models/gpt-image-2
- https://developers.openai.com/api/docs/guides/image-generation
- https://developers.openai.com/api/docs/guides/your-data
