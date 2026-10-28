# Visully integrated release QA — 28 October 2026

## Scope and integration state

Release-candidate branch: `integration/visully-security-privacy-billing-20261028`.

GitHub PR #18 merged `fix/visully-privacy-requests-redaction-20261028` into the security branch's frozen release candidate. The candidate therefore includes:
- Shopify billing monthly/annual plans and verified one-time top-ups;
- DOM allowlist and storefront link/image URL hardening, Dependabot automation;
- privacy request tracking migration, authenticated export UI, customer/shop redaction webhook handling.

**No Railway deploy, Shopify app release, production DB migration, upstream Bilaal77 merge, or App Store submission was performed.** Historical branch tests do not certify this newly combined commit.

## 1. Pull and verify working tree (PowerShell)

```powershell
cd C:\Users\malik\Downloads\tryora-github
git status --short
# Preserve local changes (notably shopify-app/extensions/tryora-theme/assets/tryora.js)
# before switching branches, if Git cannot switch safely:
# git stash push -m "local-before-visully-integration" -- shopify-app/extensions/tryora-theme/assets/tryora.js
git fetch personal
git switch --track personal/integration/visully-security-privacy-billing-20261028
git log -1 --format="%h %s"
```

If the local integration branch already exists, run `git switch integration/visully-security-privacy-billing-20261028` then `git pull --ff-only personal integration/visully-security-privacy-billing-20261028` instead.

## 2. Local regression gate (without changing customer data)

```powershell
# Run from repository root
npm run build
npm run test --workspaces --if-present
npm --prefix shopify-app run test
npm --prefix shopify-app run typecheck
npm --prefix shopify-app run build

# Specific post-integration checks, if diagnosis is needed
cd shopify-app
npx vitest run test/privacy-compliance.test.ts test/lead-privacy.test.ts test/billing-purchases.test.ts test/billing-status.test.ts test/storefront-html-guard.test.ts test/storefront-boot.test.ts
npx shopify app config validate --config visully
npx shopify app security check --config visully --include-dir ../packages
npx shopify app security review --config visully
```

Expected gate: **0 failed tests, typecheck/build success, no new high security findings**. Tests previously run on separate branches: 759 Shopify-app tests passed, 40 skipped; 75 core tests passed; 212-file deterministic scan had 0 findings. These are **pre-integration** results. Check skipped E2E separately; do not mark them passed.

## 3. Staging database migration (never on production test data)

First verify `DATABASE_URL` resolves to a dedicated disposable staging Postgres database, not Railway production. Do not print credentials to logs. Make a backup/snapshot and verify the intended environment before proceeding.

```powershell
cd C:\Users\malik\Downloads\tryora-github\shopify-app
npx prisma generate
npx prisma migrate status
# After verifying the staging database:
npx prisma migrate deploy
npx prisma migrate status
```

Expected: `20261028090000_privacy_request_tracking` applied once. `PrivacyRequest` table exists, foreign key to `Shop` and unique `shopId + requestId`. Test repeat deployment, rollback/recovery plan, and seeded synthetic data. Do not use `prisma migrate reset` against a shared database.

## 4. Signed privacy webhook QA (staging only)

- Deploy the **staging web app** and staging database migration before deliveries; point a **development app/config** at staging, not the live Visully app if that config currently targets Railway production.
- Verify Shopify HMAC: valid signed JSON => 2xx; invalid/missing signature => 401; spoofed shop/topic rejected. Avoid logging personal info.
- `customers/data_request`: creates one pending request ticket; repeated delivery remains idempotent; merchant can export only own shop's records with attachment and `Cache-Control: no-store`. Export means `exported`, **not fulfilled**; arrange secure delivery to merchant/customer.
- `customers/redact`: test both Shopify-ID-only and email-only subject; ensure matching leads, consent and linked customer identifiers are deleted/cleared without deleting unrelated customer or shop data; duplicate deliveries safe.
- `shop/redact`: remove synthetic shop and owned data plus sessions; never send this test to any merchant/production shop.
- Test two separate development shops to prove no cross-shop read/deletion. Test >1000-row export refusal/manual handling.
- Shopify CLI can deliver a **fixed sample** event to staging, but it does **not** test actual subscriptions or retry behavior:
```powershell
npx shopify app webhook trigger --config visully --api-version 2026-10 --topic customers/data_request --address https://STAGING-HOST/webhooks/compliance
```
Use only after verifying the destination is an isolated, correctly configured staging service. Trigger other redact topics only against disposable test shops/data.

## 5. Billing QA (development store with test charges only)

**Confirm Shopify app is configured for Manual Pricing**, required by this branch's `appPurchaseOneTimeCreate` 100-credit top-up model. Shopify App Pricing does not support the same one-time purchase flow.

- Fresh install => Free plan, 10 previews; no payment.
- Starter monthly: $29 / month, 100 previews/month after active Shopify verification, no grants before acceptance.
- Starter yearly: $290 / year but only 100 **new previews each UTC month**, not 1200 credits immediately. Check Growth ($69/$690, 300) and Scale ($159/$1590, 800).
- $25 top-up: decline => 0 credits; approve => +100 once, including refresh, duplicate return, retry and concurrent reconcile.
- Change plan, cancel to Free, reinstall, failed billing GraphQL response; verify no unchecked entitlements.
- Verify trial behavior and correct pricing/merchant plan copy in the real Shopify test UI, not just unit tests.

## 6. Storefront / merchant acceptance QA

- Install Visully on a disposable Shopify store; product preview + Room Assistant both launch on eligible products; assistant works on home/collection pages.
- Confirm the two welcome cards, photo-first flow, recommendation cards, fabric -> dependent colour selection, exact variant preview and swatch image/hex fallback.
- Verify one preview job at a time, proper credit counting, generated image shows inside chat, original-versus-result comparison and existing-product preview reuse without additional charge.
- Test mobile/desktop, popup, refresh/back, active preview restoration, privacy page access, consent and lead gates.
- Check generated `shopify-app/extensions/tryora-theme/assets/tryora.js` matches the currently built storefront. Preserve local changes before resetting or switching. Check Shopify app scopes and real merchant onboarding.

## 7. Final release gates

- Download and investigate **the exact 35 checks** from locally generated `.shopify/app-security/shopify.app.visully/agent-checks.json`. Record all statuses/finding evidence through Shopify CLI; do not fabricate pass status.
- Confirm public privacy policy, customer-data protections, provider retention wording, app scopes, GDPR delivery process, support contacts, E2E/storefront smoke tests, paid billing review and migration backup.
- Sync this integrated commit with the **latest Bilal upstream production branch** and resolve any differences before production merge.
- **Deploy Railway web app and apply verified production migration first, only after staged rollout approval**. Ensure available migrations are compatible with live data and use planned backups/rollback.
- Shopify `app deploy --no-release` creates a **non-live app config/extension version**; it does not deploy the Railway server. Release only after validation. Shopify App Store **listing submission is a separate action**.

## References

- https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
- https://shopify.dev/docs/api/shopify-cli/app/app-webhook-trigger
- https://shopify.dev/docs/apps/launch/billing/manual-pricing
- https://shopify.dev/docs/api/shopify-cli/app/app-deploy
