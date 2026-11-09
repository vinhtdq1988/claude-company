CREATE TYPE "public"."management_target_kind" AS ENUM('org_unit', 'team');--> statement-breakpoint
CREATE TYPE "public"."member_kind" AS ENUM('ai', 'human');--> statement-breakpoint
CREATE TYPE "public"."org_unit_kind" AS ENUM('division', 'department');--> statement-breakpoint
CREATE TABLE "management_assignment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"manager_member_id" uuid NOT NULL,
	"target_kind" "management_target_kind" NOT NULL,
	"target_id" uuid NOT NULL,
	CONSTRAINT "management_assignment_target_unique" UNIQUE("company_id","target_kind","target_id")
);
--> statement-breakpoint
CREATE TABLE "org_template" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"definition" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_template_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "org_unit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" "org_unit_kind" NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "org_unit_name_length" CHECK (char_length("org_unit"."name") between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "team" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"org_unit_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "team_name_length" CHECK (char_length("team"."name") between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "team_membership" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"team_id" uuid NOT NULL,
	"member_kind" "member_kind" NOT NULL,
	"member_id" uuid NOT NULL,
	CONSTRAINT "team_membership_unique" UNIQUE("team_id","member_kind","member_id")
);
--> statement-breakpoint
ALTER TABLE "management_assignment" ADD CONSTRAINT "management_assignment_manager_member_id_human_member_id_fk" FOREIGN KEY ("manager_member_id") REFERENCES "public"."human_member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_unit" ADD CONSTRAINT "org_unit_parent_id_org_unit_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."org_unit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team" ADD CONSTRAINT "team_org_unit_id_org_unit_id_fk" FOREIGN KEY ("org_unit_id") REFERENCES "public"."org_unit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_membership" ADD CONSTRAINT "team_membership_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "management_assignment_manager_idx" ON "management_assignment" USING btree ("company_id","manager_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_unit_name_unique" ON "org_unit" USING btree ("company_id",coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid),"name") WHERE "org_unit"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "org_unit_parent_idx" ON "org_unit" USING btree ("company_id","parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "team_name_unique" ON "team" USING btree ("company_id","org_unit_id","name") WHERE "team"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "team_membership_member_idx" ON "team_membership" USING btree ("company_id","member_kind","member_id");
--> statement-breakpoint
-- RLS theo company_id cho mọi bảng nghiệp vụ; `org_template` là dữ liệu seed dùng chung nên không bật RLS.
SELECT enable_company_rls('org_unit'::regclass);
--> statement-breakpoint
SELECT enable_company_rls('team'::regclass);
--> statement-breakpoint
SELECT enable_company_rls('team_membership'::regclass);
--> statement-breakpoint
SELECT enable_company_rls('management_assignment'::regclass);
