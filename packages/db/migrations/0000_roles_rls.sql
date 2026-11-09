-- Role ứng dụng và helper RLS. Migration này không tạo policy cho bảng cụ thể (chưa có bảng nào).
-- Mật khẩu của app_user được migrate.ts đặt từ APP_DB_PASSWORD.
-- cc_system_scan (BYPASSRLS, NOLOGIN) chỉ làm chủ các hàm SECURITY DEFINER trả company_id (D3);
-- tạo role này cần quyền superuser, nên migration chạy bằng role owner (DATABASE_MIGRATION_URL).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cc_system_scan') THEN
    CREATE ROLE cc_system_scan NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_user, cc_system_scan;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_user;
--> statement-breakpoint
-- Bật RLS + FORCE (áp dụng cả với chủ bảng) và tạo policy cô lập theo company.
-- Chưa đặt app.company_id thì NULLIF trả NULL nên không có dòng nào khớp.
CREATE OR REPLACE FUNCTION enable_company_rls(tbl regclass, col text DEFAULT 'company_id')
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s USING (%I = NULLIF(current_setting(''app.company_id'', true), '''')::uuid) WITH CHECK (%I = NULLIF(current_setting(''app.company_id'', true), '''')::uuid)',
    tbl, col, col
  );
END
$$;
