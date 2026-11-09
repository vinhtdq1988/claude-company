CREATE TABLE "domain_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"type" text NOT NULL,
	"aggregate_kind" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "domain_event_company_seq_unique" UNIQUE("company_id","seq")
);
--> statement-breakpoint
CREATE INDEX "domain_event_unpublished_idx" ON "domain_event" USING btree ("company_id","seq") WHERE "domain_event"."published_at" is null;
--> statement-breakpoint
SELECT enable_company_rls('domain_event'::regclass);
--> statement-breakpoint
-- D3: relay outbox cần biết công ty nào còn event chưa phát. Hàm chỉ trả company_id, chủ sở hữu
-- cc_system_scan (BYPASSRLS) chỉ được đọc đúng hai cột này của domain_event.
GRANT SELECT (company_id, published_at) ON domain_event TO cc_system_scan;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION list_companies_with_unpublished_events()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT company_id FROM domain_event WHERE published_at IS NULL
$$;
--> statement-breakpoint
ALTER FUNCTION list_companies_with_unpublished_events() OWNER TO cc_system_scan;
--> statement-breakpoint
REVOKE ALL ON FUNCTION list_companies_with_unpublished_events() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION list_companies_with_unpublished_events() TO app_user;
