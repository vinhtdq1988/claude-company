CREATE TYPE "public"."ai_employee_kind" AS ENUM('employee', 'manager');--> statement-breakpoint
CREATE TYPE "public"."ai_employee_status" AS ENUM('active', 'suspended', 'archived');--> statement-breakpoint
CREATE TYPE "public"."ai_manager_kind" AS ENUM('human', 'ai');--> statement-breakpoint
CREATE TYPE "public"."ai_runtime_kind" AS ENUM('claude_agent_sdk', 'messages_api');--> statement-breakpoint
CREATE TYPE "public"."ai_seniority" AS ENUM('junior', 'middle', 'senior', 'expert');--> statement-breakpoint
CREATE TYPE "public"."workspace_kind" AS ENUM('git_repo', 'docs_folder');--> statement-breakpoint
CREATE TABLE "ai_employee" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"avatar_key" text NOT NULL,
	"position" text NOT NULL,
	"home_org_unit_id" uuid NOT NULL,
	"kind" "ai_employee_kind" NOT NULL,
	"role_template_key" text,
	"personality" text DEFAULT '' NOT NULL,
	"skills" text[] DEFAULT '{}'::text[] NOT NULL,
	"seniority" "ai_seniority" NOT NULL,
	"model_id" text NOT NULL,
	"runtime_kind" "ai_runtime_kind" NOT NULL,
	"system_prompt" text NOT NULL,
	"tool_grants" text[] DEFAULT '{}'::text[] NOT NULL,
	"workspace_id" uuid,
	"manager_kind" "ai_manager_kind" NOT NULL,
	"manager_id" uuid NOT NULL,
	"max_concurrent_tasks" integer DEFAULT 2 NOT NULL,
	"status" "ai_employee_status" DEFAULT 'active' NOT NULL,
	CONSTRAINT "ai_employee_name_length" CHECK (char_length("ai_employee"."name") between 1 and 80),
	CONSTRAINT "ai_employee_max_concurrent_positive" CHECK ("ai_employee"."max_concurrent_tasks" >= 1),
	CONSTRAINT "ai_employee_manager_runtime" CHECK ("ai_employee"."kind" <> 'manager' or "ai_employee"."runtime_kind" = 'messages_api')
);
--> statement-breakpoint
CREATE TABLE "role_template" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"defaults" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_template_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "workspace" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"kind" "workspace_kind" NOT NULL,
	"mount_path" text NOT NULL,
	"default_branch" text,
	CONSTRAINT "workspace_company_mount_unique" UNIQUE("company_id","mount_path"),
	CONSTRAINT "workspace_name_length" CHECK (char_length("workspace"."name") between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "model_price" (
	"id" uuid PRIMARY KEY NOT NULL,
	"model_id" text NOT NULL,
	"input_per_mtok" numeric(12, 6) NOT NULL,
	"output_per_mtok" numeric(12, 6) NOT NULL,
	"cache_read_per_mtok" numeric(12, 6) NOT NULL,
	"cache_write_per_mtok" numeric(12, 6) NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_price_effective_unique" UNIQUE("model_id","effective_from")
);
--> statement-breakpoint
ALTER TABLE "ai_employee" ADD CONSTRAINT "ai_employee_home_org_unit_id_org_unit_id_fk" FOREIGN KEY ("home_org_unit_id") REFERENCES "public"."org_unit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_employee" ADD CONSTRAINT "ai_employee_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_employee_home_idx" ON "ai_employee" USING btree ("company_id","home_org_unit_id");--> statement-breakpoint
CREATE INDEX "ai_employee_manager_idx" ON "ai_employee" USING btree ("company_id","manager_kind","manager_id");--> statement-breakpoint
CREATE INDEX "model_price_lookup_idx" ON "model_price" USING btree ("model_id","effective_from");
--> statement-breakpoint
-- RLS theo company_id; `role_template` và `model_price` là cấu hình toàn cục nên không bật RLS.
SELECT enable_company_rls('workspace'::regclass);
--> statement-breakpoint
SELECT enable_company_rls('ai_employee'::regclass);
