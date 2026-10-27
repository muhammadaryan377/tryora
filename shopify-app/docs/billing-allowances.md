# Store status and preview allowances

The server reads `shop.plan.partnerDevelopment` and this app's active subscriptions using the authenticated Shopify Admin GraphQL client (API 2026-07). Store classification is separate from subscription status: `DEVELOPER` never activates a paid plan. Query parameters, form fields and storefront data cannot override classification. Failed or incomplete Shopify responses produce `UNVERIFIED` and no new grants; existing credits remain available.

Live stores without managed subscriptions or existing paid entitlements receive 10 Free previews per UTC calendar month. Allowances are granted lazily from the billing page, dashboard or preview flow. Each grant expires on the first of the next month; unused monthly credits do not roll over.

Verified development stores use `TRYORA_DEV_TEST_CREDITS_PER_MONTH` (integer 0–10000). Missing, invalid or zero values grant no new test credits. Set this on the server to a finite approved testing budget. After a month's grant exists, changing the setting does not refill that month's credits. The next month's grant uses the new value. Store-type transitions share the same monthly grant reference, so changing classification cannot claim both allowances.

The existing per-shop transaction lock and append-only ledger make grants idempotent under concurrent requests. Legacy trial and paid grants, consumptions, reservations, refunds and top-ups are retained. Existing trial/period credits carried into a month and credits used that month count against the new monthly budget, avoiding duplicate credits during migration. Credits consumed before the current month do not reduce that month's allowance. Paid entitlements are not overwritten or auto-activated, and paid grants are not replaced by Free grants. No database migration is required.

Starter ($29 / 100 previews), Growth ($69 / 300) and Scale ($159 / 800) share `app/plans.ts` with the Shopify billing configuration. This change does not create or approve subscriptions, issue paid plan credits, or deploy the app. Historical Shopify subscription prices are not rewritten.
