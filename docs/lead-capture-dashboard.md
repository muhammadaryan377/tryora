# Preview lead dashboard

Preview form submissions retain email, optional first name, the explicit marketing checkbox and its wording in LeadDelivery. Authenticated merchants see only their own shop's paginated leads under Leads & offers. Shopify Customers sync remains best-effort; failures do not discard the local contact or block the preview. No photo, generated image, email or name is written to logs or browser storage.

The merchant can switch collection off; the lead endpoint rechecks that setting and saves nothing when off. Existing required/optional and before/after-preview choices remain. The checkbox is not a prerequisite for lead capture. Submitting an email alone does not grant marketing consent.

Historical records have null email/name and are labelled as older records. Historical failed submissions cannot be reconstructed. Counts include retained email contacts and legacy confirmed Shopify customer saves, including repeated submissions; failed legacy attempts are excluded. These are submission counts, not unique shoppers.

Customer redaction matches both Shopify IDs and email, including failed-sync leads. Shop redaction still cascades to all lead rows. Customer data requests log only the count; the merchant must provide the retained data through their existing privacy response process using the dashboard.

## Release

The additive migration `shopify-app/prisma/migrations/202610260001_lead_contact_details/migration.sql` adds four nullable/defaulted contact columns and a shop/email index. Regenerate Prisma client during the build. Apply this reviewed migration to the target database before deploying the backend; follow the existing database baseline procedure rather than blindly replaying older migrations. No production migration is applied by this change. Shopify extension release updates the capture-form disclosure; the backend/database release is required for persistence and the dashboard. No new Shopify scopes.

## Required deployment step for the 27 October lead changes

An email may fail with "We couldn't save your details just now" even when previews work with Lead Capture OFF. Lead Capture ON writes to both `LeadDelivery` and `LeadVisit`; code deployment alone does **not** install those database columns/table. The new error response `LEAD_DATABASE_UPDATE_REQUIRED` (HTTP 503) and privacy-safe Railway log event `lead_capture_failure` with `reason: "migration_required"` identify a missing table/column. These are diagnostic signals, not permission to skip the email step.

**Operator action, after database backup/restore verification and schema review** (against the SAME PostgreSQL `DATABASE_URL` used by the Railway production service):

1. From `shopify-app/`, run `npm run db:status`. If this database predates the committed Prisma migration baseline, first follow the existing baseline/resolve procedure in `docs/release-safety-review.md`; do not blindly replay legacy migrations or run `prisma db push`.
2. Review and apply the outstanding migrations, in order, with `npm run db:deploy`. Especially verify `202610260001_lead_contact_details` (columns `email`, `firstName`, `marketingOptIn`, `marketingWording`), `202610270001_lead_capture_opt_in_default`, and `202610270002_lead_visitor_gates` (the `LeadVisit` table). Apply once through an authorized deployment job; do not edit production tables manually.
3. Confirm `npm run db:status` is clear, then deploy the matching backend and Shopify extension. Test a NEW visitor on a development store with Lead Capture Required: valid email and optional first name must appear in **Leads & offers**, the user must generate successfully, and the Shopify customer-sync status may independently show failed without blocking image generation. Verify consent is not subscribed unless the checkbox was selected.
4. If a form still fails, inspect Railway for the **privacy-safe** event `lead_capture_failure` and its `reason`. Never log submitted email, customer name, raw SQL exceptions, or image bytes. Check the proxy network response status and Shopify app proxy authentication.

The app intentionally does not auto-run destructive or out-of-order migrations on startup. Until the database is upgraded, **Required** lead capture must fail closed; switching lead capture OFF for testing is not a production fix. Saving lead contact and two channel authorization records now uses one database transaction, avoiding a partial contact when the visitor proof fails. Failed optional analytics and Shopify customer sync do not block a successfully saved lead.
