CREATE TYPE "public"."milestone_key" AS ENUM('first_employee', 'first_department', 'first_approved_task');--> statement-breakpoint
CREATE TABLE "milestone" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"key" "milestone_key" NOT NULL,
	"achieved_at" timestamp with time zone NOT NULL,
	"source_event_seq" bigint NOT NULL,
	CONSTRAINT "milestone_company_key_unique" UNIQUE("company_id","key")
);

--> statement-breakpoint
-- RLS theo company_id như mọi bảng nghiệp vụ.
SELECT enable_company_rls('milestone'::regclass);
