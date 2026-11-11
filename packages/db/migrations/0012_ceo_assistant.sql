CREATE TYPE "public"."task_proposal_status" AS ENUM('pending', 'ready', 'failed');--> statement-breakpoint
ALTER TYPE "public"."adapter_mode" ADD VALUE 'internal';--> statement-breakpoint
ALTER TYPE "public"."run_purpose" ADD VALUE 'propose';--> statement-breakpoint
ALTER TABLE "ai_employee" ALTER COLUMN "home_org_unit_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "proposal_status" "task_proposal_status";--> statement-breakpoint
CREATE UNIQUE INDEX "ai_employee_one_ceo_assistant" ON "ai_employee" USING btree ("company_id") WHERE "ai_employee"."role_template_key" = 'ceo_assistant' and "ai_employee"."status" <> 'archived';--> statement-breakpoint
ALTER TABLE "ai_employee" ADD CONSTRAINT "ai_employee_home_org_unit_required" CHECK ("ai_employee"."home_org_unit_id" is not null or "ai_employee"."role_template_key" = 'ceo_assistant');