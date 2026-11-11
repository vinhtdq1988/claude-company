CREATE TABLE "workspace_setting" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"root_path" text NOT NULL,
	CONSTRAINT "workspace_setting_company_unique" UNIQUE("company_id"),
	CONSTRAINT "workspace_setting_root_length" CHECK (char_length("workspace_setting"."root_path") between 1 and 512)
);
--> statement-breakpoint
-- RLS theo company_id như mọi bảng nghiệp vụ.
SELECT enable_company_rls('workspace_setting'::regclass);
