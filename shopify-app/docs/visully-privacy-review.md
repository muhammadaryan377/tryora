# Visully — privacy handling and Shopify review checklist

## Customer personal data handled by Visully

- Lead form data: email, optional first name, selected product/variant, timestamp, lead delivery status and marketing opt-in decision.
- Optional consent audit records: wording and customer reference/email-derived identifier.
- Preview records: verified Shopify customer ID where provided; job metadata and nonreversible hash of normalized room photo.
- Shopify data requests: request ID, customer ID/email, received date and export state. These contain customer identifiers; limit retention and restrict DB access.
- Room photo bytes and generated images: the application handles them transiently, and does not persist the bytes in its Postgres tables or disk. **This does not certify that OpenAI, Shopify or infrastructure providers have zero retention.** Confirm providers' actual data agreements before writing public claims.

## Workflow

1. `customers/data_request` webhook creates a shop-scoped request ticket, idempotent by Shopify's request ID.
2. The authenticated merchant opens **Privacy requests** and downloads an export of Visully-held lead and consent information. The app marks the ticket **exported**, not fulfilled.
3. The merchant must securely provide requested information to the relevant party, follow applicable law and complete the Shopify request within its required timeframe. Export does not automatically send email.
4. `customers/redact` removes matching retained lead records, clears customer IDs attached to preview/quota metadata, deletes matching consent records and request tickets. Email-only payloads resolve associated customer IDs from matching leads first.
5. `shop/redact` removes the shop and all owned records through relational cascades, and separately removes Shopify sessions.

## Release gates

- Database migration `20261028090000_privacy_request_tracking` must run successfully on an isolated staging database **before** sending test compliance webhooks.
- Test signed Shopify webhooks on staging with synthetic leads/consents, including IDs and email-only payloads. Never run redaction tests against real merchants or production data.
- Confirm auth, access control, no-store headers, encrypted transport, no PII in logs, export pagination limits and zero cross-shop leakage.
- Establish support handling for oversized (>1000) customer exports, failed webhook retries, and secure delivery of exported files.
- Publish an approved Visully privacy policy and verify its URL in the Shopify App Store listing. Include provider-specific retention terms, customer request contact, lead retention period and purpose limitations.
- Determine safe operational retention/deletion policy for privacy request tickets. Pending items should be addressed promptly, not silently purged.
- Confirm the 35 Shopify agent-review security checks separately from deterministic scan.

**Caution:** This code implements an authenticated merchant export and deletion workflow; it does not itself complete the merchant's delivery of a customer data-request response or constitute legal certification.
