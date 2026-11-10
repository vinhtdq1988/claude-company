CREATE TYPE "public"."employee_state" AS ENUM('idle', 'working', 'thinking', 'communicating', 'meeting', 'waiting_approval', 'completed', 'error_blocked', 'break');--> statement-breakpoint
CREATE TYPE "public"."office_zone_kind" AS ENUM('department', 'ceo_office', 'break_room');--> statement-breakpoint
CREATE TABLE "employee_status" (
	"company_id" uuid NOT NULL,
	"ai_employee_id" uuid NOT NULL,
	"state" "employee_state" DEFAULT 'idle' NOT NULL,
	"current_task_id" uuid,
	"current_tool" text,
	"progress" integer,
	"suspended" boolean DEFAULT false NOT NULL,
	"tracks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"applied_seq" bigint DEFAULT 0 NOT NULL,
	"source_event_seq" bigint DEFAULT 0 NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employee_status_company_id_ai_employee_id_pk" PRIMARY KEY("company_id","ai_employee_id"),
	CONSTRAINT "employee_status_progress_range" CHECK ("employee_status"."progress" is null or "employee_status"."progress" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "employee_status_change" (
	"company_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"ai_employee_id" uuid NOT NULL,
	"state" "employee_state" NOT NULL,
	"previous_state" "employee_state" NOT NULL,
	"current_task_id" uuid,
	"current_tool" text,
	"progress" integer,
	"source_event_type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "employee_status_change_company_id_seq_ai_employee_id_pk" PRIMARY KEY("company_id","seq","ai_employee_id")
);
--> statement-breakpoint
CREATE TABLE "office_cursor" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"applied_seq" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "office_zone" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" "office_zone_kind" NOT NULL,
	"org_unit_id" uuid,
	"name" text NOT NULL,
	"layout" jsonb NOT NULL,
	CONSTRAINT "office_zone_department_org_unit" CHECK (("office_zone"."kind" = 'department') = ("office_zone"."org_unit_id" is not null))
);
--> statement-breakpoint
CREATE INDEX "employee_status_change_employee_idx" ON "employee_status_change" USING btree ("company_id","ai_employee_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "office_zone_org_unit_unique" ON "office_zone" USING btree ("company_id","org_unit_id") WHERE "office_zone"."org_unit_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "office_zone_fixed_kind_unique" ON "office_zone" USING btree ("company_id","kind") WHERE "office_zone"."kind" <> 'department';
--> statement-breakpoint
-- RLS theo company_id như mọi bảng nghiệp vụ.
SELECT enable_company_rls('employee_status'::regclass);
--> statement-breakpoint
SELECT enable_company_rls('employee_status_change'::regclass);
--> statement-breakpoint
SELECT enable_company_rls('office_cursor'::regclass);
--> statement-breakpoint
SELECT enable_company_rls('office_zone'::regclass);
