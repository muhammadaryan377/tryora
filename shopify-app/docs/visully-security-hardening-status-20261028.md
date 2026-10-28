# Visully security hardening — 28 October 2026

## Branch and scope

Work is isolated to `fix/visully-security-hardening-20261028` in `muhammadaryan377/tryora`.
The intended `integration/visully-complete-20261028` ref was **not present in this GitHub mirror**, so this branch starts at `feat/visully-billing-monthly-annual-topups-20261028`. The separate `fix/visully-privacy-requests-redaction-20261028` work is **not integrated**. Do not merge this branch into production without first reconciling the expected integration baseline and privacy changes.

## Source findings investigated

- **Verified navigation weakness:** `packages/storefront/src/assistant/drawer.ts` used dynamic recommendation URLs in product/card/preview/handoff links and `location.assign`, escaping HTML metacharacters but not validating URL schemes or destination paths.
- **Mitigation committed:** `packages/storefront/src/assistant/url-security.ts` accepts only canonical, storefront-relative `/products/<Shopify handle>` links with an optional numeric variant ID. Dangerous schemes, protocol-relative/off-site links, path traversal, unexpected query parameters and malformed handles are rejected before markup or navigation.
- **Dynamic remote images:** `assistant/drawer.ts` and `main.ts` now reject non-HTTPS or credential-bearing dynamic product/sample images before inserting them in HTML. Blob URLs created for local photo/preview media retain their previous behavior.
- **Existing backend protection confirmed by source inspection:** `shopify-app/app/assistant/catalogue.server.ts` already constructs product links from validated Shopify handles instead of using `onlineStoreUrl`. `shopify-app/test/assistant-password-store.test.ts` includes regression cases for malicious handles and foreign-origin product URLs. This statement is a source review, not proof the tests passed in this branch.
- **Dependency update checks:** Added `.github/dependabot.yml` with weekly npm updates for both lockfile roots and GitHub Actions.

## Tests added

- `shopify-app/test/storefront-url-security.test.ts`: validates good/bad product links, image schemes, malformed values.
- `shopify-app/test/room-assistant-ui.test.ts`: added dynamic DOM regression cases for inert unsafe product links and fallback thumbnails while preserving safe links and images.
- An isolated Node check of the URL-validation algorithm passed locally (5 allowed product links, 17 blocked product links, 2 allowed image URLs, 6 blocked image URLs). **This is not a complete app test run.**

## Unresolved / required validation

1. **11 `UNSAFE_INNERHTML` scanner findings:** All still require a fresh Shopify CLI scan and sink-by-sink review; this work does not suppress or hide scanner rules, and does not claim the findings were all eliminated. Some `innerHTML` sinks use escaped text or fixed SVG templates, but they must be reviewed against their actual data sources.
2. **35 Shopify semantic agent checks:** The exact `.shopify/app-security/shopify.app.visully/agent-checks.json` file was not present in the accessible GitHub tree. None is claimed passed, failed or not-applicable by this report. Read the local CLI-generated file and investigate/record each check.
3. **Full TypeScript, build, unit and E2E tests:** Not run from this GitHub-only edit environment. The pre-change figure of 729 passing tests must not be reused as a post-change pass count.
4. **Privacy webhooks and billing:** Do not claim verified. Reconcile the separate privacy branch, then stage and test `customers/data_request`, `customers/redact` and `shop/redact` with signed Shopify requests, and check billing after code integration.
5. **External image destinations:** Protocol checks were added, but an approved-host allowlist has not been verified against every merchant sample/image provider. Treat host authorization as unresolved rather than claiming all images are origin-restricted.

## Commands to run locally

```powershell
git fetch --all --prune
git switch fix/visully-security-hardening-20261028
npm run build
npm run test --workspaces --if-present
npm --prefix shopify-app run typecheck
npm --prefix shopify-app run build
cd shopify-app
npx shopify app security check --config visully --include-dir ../packages
npx shopify app security review --config visully
```

Do not deploy, release or merge until these checks and the complete integration-baseline review succeed.
