CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TABLE "approval_request" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tool_invocation_id" uuid NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"ai_employee_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"summary" text NOT NULL,
	"rationale" text DEFAULT '' NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"approver_member_id" uuid,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"last_reminded_at" timestamp with time zone,
	CONSTRAINT "approval_request_invocation_unique" UNIQUE("tool_invocation_id")
);
--> statement-breakpoint
CREATE INDEX "approval_request_status_idx" ON "approval_request" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "approval_request_task_idx" ON "approval_request" USING btree ("company_id","task_id");--> statement-breakpoint
CREATE INDEX "approval_request_approver_idx" ON "approval_request" USING btree ("company_id","approver_member_id","status");
--> statement-breakpoint
-- RLS theo company_id như mọi bảng nghiệp vụ.
SELECT enable_company_rls('approval_request'::regclass);
--> statement-breakpoint
-- D3: sweeper nhắc người duyệt cần biết công ty nào còn yêu cầu đang chờ. Hàm chỉ đọc bảng của Permission Engine
-- và chỉ trả company_id; chủ sở hữu cc_system_scan (BYPASSRLS) chỉ được SELECT đúng các cột đó.
GRANT SELECT (company_id, status) ON approval_request TO cc_system_scan;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION list_companies_with_pending_approvals()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT company_id FROM approval_request WHERE status = 'pending'
$$;
--> statement-breakpoint
ALTER FUNCTION list_companies_with_pending_approvals() OWNER TO cc_system_scan;
--> statement-breakpoint
REVOKE ALL ON FUNCTION list_companies_with_pending_approvals() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION list_companies_with_pending_approvals() TO app_user;
