# Preview lead dashboard

Preview form submissions retain email, optional first name, the explicit marketing checkbox and its wording in LeadDelivery. Authenticated merchants see only their own shop's paginated leads under Leads & offers. Shopify Customers sync remains best-effort; failures do not discard the local contact or block the preview. No photo, generated image, email or name is written to logs or browser storage.

The merchant can switch collection off; the lead endpoint rechecks that setting and saves nothing when off. Existing required/optional and before/after-preview choices remain. The checkbox is not a prerequisite for lead capture. Submitting an email alone does not grant marketing consent.

Historical records have null email/name and are labelled as older records. Historical failed submissions cannot be reconstructed. Counts include retained email contacts and legacy confirmed Shopify customer saves, including repeated submissions; failed legacy attempts are excluded. These are submission counts, not unique shoppers.

Customer redaction matches both Shopify IDs and email, including failed-sync leads. Shop redaction still cascades to all lead rows. Customer data requests log only the count; the merchant must provide the retained data through their existing privacy response process using the dashboard.

## Release

The additive migration `shopify-app/prisma/migrations/202610260001_lead_contact_details/migration.sql` adds four nullable/defaulted contact columns and a shop/email index. Regenerate Prisma client during the build. Apply this reviewed migration to the target database before deploying the backend; follow the existing database baseline procedure rather than blindly replaying older migrations. No production migration is applied by this change. Shopify extension release updates the capture-form disclosure; the backend/database release is required for persistence and the dashboard. No new Shopify scopes.
