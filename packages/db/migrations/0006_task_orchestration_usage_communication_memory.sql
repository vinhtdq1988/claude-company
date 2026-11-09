CREATE TYPE "public"."message_author_kind" AS ENUM('human', 'ai');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('task_completed', 'task_error', 'task_overdue', 'approval_needed', 'budget_warning', 'budget_blocked', 'overload_warning', 'escalation');--> statement-breakpoint
CREATE TYPE "public"."memory_kind" AS ENUM('task_summary', 'note');--> statement-breakpoint
CREATE TYPE "public"."memory_scope_kind" AS ENUM('ai_employee', 'team', 'org_unit');--> statement-breakpoint
CREATE TYPE "public"."adapter_mode" AS ENUM('dry_run', 'live');--> statement-breakpoint
CREATE TYPE "public"."run_purpose" AS ENUM('execute', 'decompose', 'review', 'synthesize');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'waiting_approval', 'succeeded', 'failed', 'timed_out', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."run_step_kind" AS ENUM('model_call', 'tool_call', 'message', 'system');--> statement-breakpoint
CREATE TYPE "public"."tool_invocation_status" AS ENUM('denied', 'pending_approval', 'pending', 'executing', 'succeeded', 'failed', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."artifact_kind" AS ENUM('document', 'code_diff', 'test_report', 'file');--> statement-breakpoint
CREATE TYPE "public"."evidence_verdict" AS ENUM('met', 'not_met');--> statement-breakpoint
CREATE TYPE "public"."review_decision" AS ENUM('pass', 'rework', 'approve', 'reject');--> statement-breakpoint
CREATE TYPE "public"."review_stage" AS ENUM('ai_review', 'human_approval');--> statement-breakpoint
CREATE TYPE "public"."reviewer_kind" AS ENUM('ai', 'human');--> statement-breakpoint
CREATE TYPE "public"."task_assignee_kind" AS ENUM('ai_employee', 'team', 'org_unit');--> statement-breakpoint
CREATE TYPE "public"."task_priority" AS ENUM('low', 'medium', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('draft', 'assigned', 'in_progress', 'in_review', 'awaiting_human_approval', 'completed', 'blocked', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."budget_reservation_status" AS ENUM('held', 'committed', 'released');--> statement-breakpoint
CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recipient_member_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"task_id" uuid,
	"approval_request_id" uuid,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "task_message" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"task_id" uuid NOT NULL,
	"author_kind" "message_author_kind" NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"agent_run_id" uuid
);
--> statement-breakpoint
CREATE TABLE "memory_entry" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"owner_scope_kind" "memory_scope_kind" NOT NULL,
	"owner_scope_id" uuid NOT NULL,
	"source_task_id" uuid,
	"kind" "memory_kind" NOT NULL,
	"content" text NOT NULL,
	"share_rule" jsonb
);
--> statement-breakpoint
CREATE TABLE "agent_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"task_id" uuid NOT NULL,
	"ai_employee_id" uuid NOT NULL,
	"purpose" "run_purpose" NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"runtime_kind" "ai_runtime_kind" NOT NULL,
	"model_id" text NOT NULL,
	"provider_session_id" text,
	"heartbeat_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error_code" text,
	"error_message" text,
	"trace_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_conversation_state" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"messages" jsonb NOT NULL,
	CONSTRAINT "run_conversation_state_agent_run_id_unique" UNIQUE("agent_run_id")
);
--> statement-breakpoint
CREATE TABLE "run_step" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" "run_step_kind" NOT NULL,
	"summary" text NOT NULL,
	"payload" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "run_step_seq_unique" UNIQUE("agent_run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "tool_invocation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"run_step_id" uuid,
	"action_type" text NOT NULL,
	"permission_level" "permission_level" NOT NULL,
	"input" jsonb NOT NULL,
	"input_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "tool_invocation_status" NOT NULL,
	"adapter_mode" "adapter_mode",
	"result" jsonb,
	CONSTRAINT "tool_invocation_idempotency_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "artifact" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"task_id" uuid NOT NULL,
	"agent_run_id" uuid,
	"created_by_employee_id" uuid,
	"kind" "artifact_kind" NOT NULL,
	"title" text NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"checksum_sha256" text NOT NULL,
	"round" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"task_id" uuid NOT NULL,
	"criterion_id" text NOT NULL,
	"artifact_id" uuid,
	"reviewer_kind" "reviewer_kind" NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"verdict" "evidence_verdict" NOT NULL,
	"explanation" text NOT NULL,
	"round" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_record" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"stage" "review_stage" NOT NULL,
	"reviewer_kind" "reviewer_kind" NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"decision" "review_decision" NOT NULL,
	"reason" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_record_reason_nonempty" CHECK (char_length(btrim("review_record"."reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "task" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"parent_task_id" uuid,
	"title" text NOT NULL,
	"objective" text NOT NULL,
	"created_by_member_id" uuid NOT NULL,
	"assigned_by_ai_employee_id" uuid,
	"assignee_kind" "task_assignee_kind" NOT NULL,
	"assignee_id" uuid NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"priority" "task_priority" NOT NULL,
	"acceptance_criteria" jsonb NOT NULL,
	"expected_output" text NOT NULL,
	"status" "task_status" DEFAULT 'draft' NOT NULL,
	"blocked_from" "task_status",
	"blocked_reason" text,
	"is_overdue" boolean DEFAULT false NOT NULL,
	"rework_count" integer DEFAULT 0 NOT NULL,
	"rework_baseline" integer DEFAULT 0 NOT NULL,
	"token_cap" bigint,
	"cost_cap" numeric(12, 6),
	"decomposition_plan" jsonb,
	"decomposed_by_employee_id" uuid,
	"completed_at" timestamp with time zone,
	CONSTRAINT "task_rework_count_nonneg" CHECK ("task"."rework_count" >= 0),
	CONSTRAINT "task_rework_baseline_range" CHECK ("task"."rework_baseline" between 0 and "task"."rework_count"),
	CONSTRAINT "task_criteria_nonempty" CHECK (jsonb_array_length("task"."acceptance_criteria") >= 1)
);
--> statement-breakpoint
CREATE TABLE "task_dependency" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"depends_on_task_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_dependency_unique" UNIQUE("task_id","depends_on_task_id"),
	CONSTRAINT "task_dependency_not_self" CHECK ("task_dependency"."task_id" <> "task_dependency"."depends_on_task_id")
);
--> statement-breakpoint
CREATE TABLE "budget_policy" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scope_kind" "policy_scope_kind" NOT NULL,
	"scope_id" uuid NOT NULL,
	"monthly_token_limit" bigint,
	"monthly_cost_limit" numeric(12, 6),
	"max_concurrent_tasks" integer,
	"allowed_models" text[],
	"warn_threshold" numeric(4, 3) DEFAULT '0.8' NOT NULL,
	CONSTRAINT "budget_policy_scope_unique" UNIQUE("company_id","scope_kind","scope_id"),
	CONSTRAINT "budget_policy_warn_range" CHECK ("budget_policy"."warn_threshold" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "budget_reservation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"ai_employee_id" uuid NOT NULL,
	"scopes" jsonb NOT NULL,
	"period" text NOT NULL,
	"reserved_tokens" bigint NOT NULL,
	"reserved_cost" numeric(12, 6) NOT NULL,
	"status" "budget_reservation_status" DEFAULT 'held' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_ledger" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"ai_employee_id" uuid NOT NULL,
	"org_unit_id" uuid,
	"team_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"model_id" text NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) NOT NULL,
	"period" text NOT NULL,
	"provider_message_id" text NOT NULL,
	"is_overage" boolean DEFAULT false NOT NULL,
	CONSTRAINT "usage_ledger_message_unique" UNIQUE("provider_message_id"),
	CONSTRAINT "usage_ledger_period_format" CHECK ("usage_ledger"."period" ~ '^[0-9]{4}-[0-9]{2}$')
);
--> statement-breakpoint
ALTER TABLE "run_conversation_state" ADD CONSTRAINT "run_conversation_state_agent_run_id_agent_run_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_step" ADD CONSTRAINT "run_step_agent_run_id_agent_run_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_invocation" ADD CONSTRAINT "tool_invocation_agent_run_id_agent_run_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_invocation" ADD CONSTRAINT "tool_invocation_run_step_id_run_step_id_fk" FOREIGN KEY ("run_step_id") REFERENCES "public"."run_step"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_artifact_id_artifact_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_record" ADD CONSTRAINT "review_record_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependency" ADD CONSTRAINT "task_dependency_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependency" ADD CONSTRAINT "task_dependency_depends_on_task_id_task_id_fk" FOREIGN KEY ("depends_on_task_id") REFERENCES "public"."task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_recipient_idx" ON "notification" USING btree ("company_id","recipient_member_id","read_at");--> statement-breakpoint
CREATE INDEX "task_message_task_idx" ON "task_message" USING btree ("company_id","task_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_entry_scope_idx" ON "memory_entry" USING btree ("company_id","owner_scope_kind","owner_scope_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_run_task_idx" ON "agent_run" USING btree ("company_id","task_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_run_employee_idx" ON "agent_run" USING btree ("company_id","ai_employee_id","status");--> statement-breakpoint
CREATE INDEX "agent_run_active_idx" ON "agent_run" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "tool_invocation_run_idx" ON "tool_invocation" USING btree ("company_id","agent_run_id");--> statement-breakpoint
CREATE INDEX "tool_invocation_task_idx" ON "tool_invocation" USING btree ("company_id","task_id","status");--> statement-breakpoint
CREATE INDEX "artifact_task_idx" ON "artifact" USING btree ("company_id","task_id","created_at");--> statement-breakpoint
CREATE INDEX "evidence_task_idx" ON "evidence" USING btree ("company_id","task_id","round");--> statement-breakpoint
CREATE INDEX "review_record_task_idx" ON "review_record" USING btree ("company_id","task_id","decided_at");--> statement-breakpoint
CREATE INDEX "task_assignee_idx" ON "task" USING btree ("company_id","assignee_kind","assignee_id","status");--> statement-breakpoint
CREATE INDEX "task_parent_idx" ON "task" USING btree ("company_id","parent_task_id");--> statement-breakpoint
CREATE INDEX "task_status_idx" ON "task" USING btree ("company_id","status","deadline");--> statement-breakpoint
CREATE INDEX "task_dependency_reverse_idx" ON "task_dependency" USING btree ("company_id","depends_on_task_id");--> statement-breakpoint
CREATE INDEX "budget_reservation_held_idx" ON "budget_reservation" USING btree ("company_id","period","status");--> statement-breakpoint
CREATE INDEX "usage_ledger_period_idx" ON "usage_ledger" USING btree ("company_id","period");--> statement-breakpoint
CREATE INDEX "usage_ledger_task_idx" ON "usage_ledger" USING btree ("company_id","task_id");--> statement-breakpoint
CREATE INDEX "usage_ledger_employee_idx" ON "usage_ledger" USING btree ("company_id","ai_employee_id","period");

--> statement-breakpoint
-- RLS theo company_id cho mọi bảng nghiệp vụ mới.
SELECT enable_company_rls('task'::regclass);
--> statement-breakpoint
SELECT enable_company_rls('task_dependency'::regclass);
--> statement-breakpoint
SELECT enable_company_rls('artifact'::regclass);
--> statement-breakpoint
SELECT enable_company_rls('evidence'::regclass);
--> statement-breakpoint
SELECT enable_company_rls('review_record'::regclass);
--> statement-breakpoint
SELECT enable_company_rls('agent_run'::regclass);
--> statement-breakpoint
SELECT enable_company_rls('run_step'::regclass);
--> statement-breakpoint
SELECT enable_company_rls('tool_invocation'::regclass);
--> statement-breakpoint
SELECT enable_company_rls('run_conversation_state'::regclass);
--> statement-breakpoint
SELECT enable_company_rls('budget_policy'::regclass);
--> statement-breakpoint
SELECT enable_company_rls('usage_ledger'::regclass);
--> statement-breakpoint
SELECT enable_company_rls('budget_reservation'::regclass);
--> statement-breakpoint
SELECT enable_company_rls('task_message'::regclass);
--> statement-breakpoint
SELECT enable_company_rls('notification'::regclass);
--> statement-breakpoint
SELECT enable_company_rls('memory_entry'::regclass);
--> statement-breakpoint
-- Bảng chỉ INSERT: `review_record` (bất biến, SC-014) và `usage_ledger` (sổ chi tiêu). Chặn bằng trigger
-- và thu hồi quyền UPDATE/DELETE của app_user (lớp thứ hai).
CREATE OR REPLACE FUNCTION forbid_row_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Bảng % chỉ cho phép INSERT', TG_TABLE_NAME USING ERRCODE = '42501';
END
$$;
--> statement-breakpoint
CREATE TRIGGER review_record_immutable BEFORE UPDATE OR DELETE ON review_record
  FOR EACH ROW EXECUTE FUNCTION forbid_row_mutation();
--> statement-breakpoint
CREATE TRIGGER usage_ledger_immutable BEFORE UPDATE OR DELETE ON usage_ledger
  FOR EACH ROW EXECUTE FUNCTION forbid_row_mutation();
--> statement-breakpoint
REVOKE UPDATE, DELETE ON review_record FROM app_user;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON usage_ledger FROM app_user;
--> statement-breakpoint
-- D3: sweeper cần biết công ty nào còn task chưa kết thúc / run đang hoạt động. Mỗi hàm chỉ đọc bảng của
-- một engine và chỉ trả company_id; chủ sở hữu cc_system_scan (BYPASSRLS) chỉ được SELECT đúng các cột đó.
GRANT SELECT (company_id, status) ON task TO cc_system_scan;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION list_companies_with_open_tasks()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT company_id FROM task WHERE status NOT IN ('completed', 'cancelled')
$$;
--> statement-breakpoint
ALTER FUNCTION list_companies_with_open_tasks() OWNER TO cc_system_scan;
--> statement-breakpoint
REVOKE ALL ON FUNCTION list_companies_with_open_tasks() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION list_companies_with_open_tasks() TO app_user;
--> statement-breakpoint
GRANT SELECT (company_id, status) ON agent_run TO cc_system_scan;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION list_companies_with_active_runs()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT company_id FROM agent_run WHERE status IN ('queued', 'running', 'waiting_approval')
$$;
--> statement-breakpoint
ALTER FUNCTION list_companies_with_active_runs() OWNER TO cc_system_scan;
--> statement-breakpoint
REVOKE ALL ON FUNCTION list_companies_with_active_runs() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION list_companies_with_active_runs() TO app_user;
