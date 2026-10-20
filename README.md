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

Pushing to `main` redeploys the server on Railway (Docker, `shopify-app/Dockerfile`; schema applied with `prisma db push`).

## Rules
- Never store shopper photos, generated images or shopper details (emails go straight to Shopify customers).
- The credits ledger is append-only; a credit is charged only when an image is delivered.
- Don't import `core/index` into browser code (admin page components); it breaks the build.
- New Shopify permissions need the owner's approval.
- `shopify-app/app/routes/app.dev-seed.tsx` is a temporary test-store-only page: remove before launch.
