CREATE TYPE "public"."permission_level" AS ENUM('auto_execute', 'review_required', 'human_approval', 'restricted');--> statement-breakpoint
CREATE TYPE "public"."policy_scope_kind" AS ENUM('company', 'org_unit', 'team', 'ai_employee');--> statement-breakpoint
CREATE TABLE "action_policy" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"action_type" text NOT NULL,
	"level" "permission_level" NOT NULL,
	"scope_kind" "policy_scope_kind" NOT NULL,
	"scope_id" uuid
);
--> statement-breakpoint
CREATE INDEX "action_policy_lookup_idx" ON "action_policy" USING btree ("company_id","action_type");
--> statement-breakpoint
SELECT enable_company_rls('action_policy'::regclass);
