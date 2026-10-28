-- Read-only: run against the database used by the deployed app.
-- Missing tables must be restored using migrations from that deployed revision.
BEGIN TRANSACTION READ ONLY;

SELECT current_database() AS database_name,
       to_regclass('public."Shop"') AS shop_table,
       to_regclass('public."LeadVisit"') AS lead_visit_table,
       to_regclass('public."PrivacyRequest"') AS privacy_request_table,
       to_regclass('public._prisma_migrations') AS migration_history_table;

SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('LeadVisit', 'PrivacyRequest')
ORDER BY table_name, ordinal_position;

COMMIT;
