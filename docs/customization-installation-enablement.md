# Merchant-managed customization: installation enablement

## Confirmed cause

`providerSettingsEnabled()` previously returned only whether the deployment environment had `TRYORA_CUSTOMIZATION_PROVIDERS_ENABLED` exactly equal to `true`. The Fabrics & Colours loader used that global value as `installationReady`. No per-installation permission record or merchant-facing activation action existed.

The screenshot is consistent with that gate being OFF in the serving backend; no production environment was inspected or changed. Save and upload were blocked, but the Manual mode option and draft editing controls remained selectable. This was misleading UI, not an authentication bypass: server actions already checked the master gate.

## Secure operator enablement

The existing reviewed `CustomizationConfig` table must already be available. This change adds no schema/migration and does not create tables, run db push or change startup behavior.

For a scoped staging rollout, an authorized app operator configures these **server environment variables** (instructions only):

```
TRYORA_CUSTOMIZATION_PROVIDERS_ENABLED=true
TRYORA_CUSTOMIZATION_PROVIDERS_SHOPS=verified-shop.myshopify.com,second-approved-shop.myshopify.com
```

Replace example hostnames with verified authenticated installation `session.shop` domains. Do not use storefront custom domains, URLs, wildcard patterns, browser-submitted shop identifiers or API credentials. Configure the allowlist before turning the master flag on, then restart the relevant backend process through the approved environment process. Do not change a production environment as part of a code-only review.

Policy:

- Master flag OFF/unset: deny provider reads/settings, regardless of the allowlist. Native previews continue through their existing path.
- Master flag ON and list configured: exact canonical myshopify.com matching, case-insensitive. Empty list denies all. Any malformed entry, wildcard, trailing empty entry or oversized policy denies the entire policy; it never broadens access.
- Master flag ON and list **unset**: preserve the previously authorized deployment-wide rollout. This is backward compatibility, not a scoped rollout. New example configuration includes an explicit empty list so new operators must name authorized installations. Always set the list when restricting rollout.
- To revoke a scoped installation, remove its hostname while keeping the variable configured. An empty value revokes all. **Unsetting the variable restores legacy global opt-in**, so it must not be used for revocation. Subsequent requests evaluate the current process policy; this is not a cancellation mechanism for already accepted jobs.

The code does not let merchants grant themselves installation access. Shopify authentication and shop ownership remain mandatory. Existing merchant staff and Shopify write_products permissions still govern product-media mutations; no new scope was requested.

## Enforcement and UI

The same shop-scoped policy protects manager loader/actions/direct save helper, advanced provider settings, runtime provider loading and admin Products provider reads. A forged `shop`/`shopId` field does not affect the authenticated session domain. Disabled installations do not read the provider table.

The Manual option and Add fabric are disabled when access is unavailable; manual form controls are locked as a fallback for stale UI data. Native inspection remains available. Diagnostics distinguish a disabled schema rollout from missing installation authorization without disclosing the allowlist.

After enablement, the existing manual workflow is unchanged: create fabrics and per-fabric colours, save the draft, upload actual media, bind exact native variants and separately approved product-owned full-product references, then save/review. A saved swatch is not proof of variant availability or a suitable generation reference. Revision checks, exact native tuples, approved media, provider checks, availableForSale, credits, original popup and in-chat validation remain in force. Saving does not change explicit product OFF or auto-enable settings.

## Verification and limitations

Local results:

- `npm test`: **75 core + 521 application tests passed (596 total)**; 34 skipped in the standard run.
- Explicit browser suites: **24 passed** (5 manager, 15 assistant, 4 popup). The remaining 10 live/paid/database opt-in cases were not activated.
- `npm run typecheck`, `npm run build`, `git diff --check`: passed.
- Desktop/mobile enabled manager workflows include real route actions against isolated upload/persistence fixtures; denied rollout, unauthorized installation and malformed policy cases verify locked controls and rejected forged requests.
- Screenshots inspected under `tools/storefront-harness/shots/customization-installation-enablement/`: `manager-disabled-other-installation.png`, `manager-disabled-rollout-off.png`, `manager-disabled-invalid-policy.png`, and `manager-manual-colours-1280.png` / `manager-manual-colours-390.png`. These ignored local artifacts contain synthetic data.

 Tests use isolated synthetic Shopify/Prisma data; no production settings, database or paid AI call was accessed. Real installation enablement, existing schema readiness and actual merchant image/reference smoke tests still require an authorized staging rollout. This patch alone does not activate any live store.

Existing external-only options remain unsupported unless verified by the existing mapping/provider path.

## Changed files

- `app/customization/provider-access.server.ts`: pure operator policy.
- `app/customization/provider-config.server.ts`: scoped runtime provider reads.
- `app/customization/fabric-manager.server.ts`: scoped direct-save authorization.
- `app/routes/app.fabrics.tsx`: authenticated installation readiness and diagnostics.
- `app/routes/app.customization.tsx`: advanced settings use the same grant.
- `app/products.server.ts`: scoped admin provider reads.
- `app/components/fabric-colour-manager.tsx`: disabled Manual option and editing controls.
- `test/provider-access.test.ts`, `test/fabric-manager.test.ts`, `test/customization-admin.test.ts`, `test/fabric-manager-browser.e2e.test.ts`: policy, cross-shop, runtime, enabled workflow and disabled UI regression coverage.
- `.env.example`, this report and `docs/customization-provider-setup.md`: operator instructions and safe defaults.

Application paths above are relative to `shopify-app/`. No secrets or actual environment files were edited. No push or deployment is included.
