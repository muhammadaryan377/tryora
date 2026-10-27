# Visully — Shopify billing implementation (October 2026)

This branch implements **Manual Pricing with Shopify's Billing API**, because the merchant can buy one-time 100-preview packs for $25. Shopify App Pricing does **not** support one-time app purchases. Do not enable Shopify App Pricing for this integration unless the business model and code are migrated together.

## Merchants

- Free: 10 previews per UTC month.
- Starter: $29/month or $290/year; 100 new previews per month.
- Growth: $69/month or $690/year; 300 new previews per month.
- Scale: $159/month or $1,590/year; 800 new previews per month.
- Annual pricing charges for ten months up front. Credits still renew **once per month**, not all twelve monthly allocations up front.
- Paid customers can buy extra 100-preview packs for $25 through Shopify one-time purchase approval.
- Cancel/switch to Free uses Shopify `billing.cancel`, with no requested proration. Confirm this business policy before launch.

## Trust boundaries

- Never activate paid entitlements solely from a selected plan, return URL, local database row or browser request. `ensureBillingAllowance` checks the authenticated installation's active subscriptions, approved plan name, status and unexpired `currentPeriodEnd`.
- Never credit a top-up from a button click or pending/declined charge. `reconcileTopUps` checks the current Shopify installation's one-time purchases, exactly matching name, approved status, price, currency and test/live context.
- Every purchase ID is the idempotency key for a ledger grant. Repeated return redirects and refreshes cannot double-credit a paid top-up.
- The top-up lookup is currently bounded to five pages of 100 most-recent transactions. For merchants with more than 500 historical one-time purchases, provide a manual reconciliation process.
- Shopify returns no billing-status data during API failures; no new paid credits should be granted until verification recovers.
- Room photos and generated images are not part of this billing flow.

## Pre-release testing

1. On a Shopify development shop associated with the Visully partner organisation, confirm it uses **Manual Pricing**.
2. Install the app fresh; verify the Free allowance appears and no payment is requested.
3. Select Starter Monthly; verify Shopify approval UI appears and no allowance is granted before payment confirmation.
4. Approve in development test mode; verify the app returns to /app/billing, saves the Shopify subscription GID and grants 100 credits **once**.
5. Refresh repeatedly, verify no duplicate grants. Simulate a new UTC month and verify a second, distinct 100-credit allowance.
6. Switch Monthly → Annual; verify exactly $290/year for Starter, and only 100 credits per month.
7. Buy a $25 top-up: decline then verify no credits. Repeat and approve; verify exactly 100 credits. Reload/return multiple times; verify no duplicate grant.
8. Switch between plans and cancel back to Free; verify Shopify status controls entitlements.
9. Validate subscription and top-up GraphQL failure behavior and Shopify installation/uninstallation.
10. Run `npm test`, `npm run typecheck`, `npm run build` at repository root; verify the generated theme bundle check.

## Deployment caution

This is an **analysis/backup mirror** PR and does not directly deploy to the upstream Bilaal77 repository, Railway or Shopify. Rebase/cherry-pick onto current production HEAD only after review, then deploy Railway server first. Shopify app versions primarily package the theme extension; they don't deploy Railway server-side billing code.
