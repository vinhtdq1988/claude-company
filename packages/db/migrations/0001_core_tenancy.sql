CREATE TYPE "public"."human_role" AS ENUM('ceo', 'manager');--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email"),
	CONSTRAINT "user_email_lowercase" CHECK ("user"."email" = lower("user"."email"))
);
--> statement-breakpoint
CREATE TABLE "human_member" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "human_role" NOT NULL,
	"title" text,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "human_member_company_user_unique" UNIQUE("company_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "company" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'Asia/Ho_Chi_Minh' NOT NULL,
	"template_key" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_name_length" CHECK (char_length("company"."name") between 1 and 120)
);
--> statement-breakpoint
ALTER TABLE "human_member" ADD CONSTRAINT "human_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- RLS: bảng nghiệp vụ theo company_id; `company` theo id. `user` là bảng toàn cục nên không bật RLS.
SELECT enable_company_rls('human_member'::regclass);
--> statement-breakpoint
SELECT enable_company_rls('company'::regclass, 'id');
--> statement-breakpoint
-- D3: /auth/me và TenantGuard chưa biết company nên đọc theo app.user_id (chỉ SELECT).
CREATE POLICY user_self_read ON human_member FOR SELECT
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY member_company_read ON company FOR SELECT
  USING (id IN (
    SELECT company_id FROM human_member
    WHERE user_id = NULLIF(current_setting('app.user_id', true), '')::uuid AND disabled_at IS NULL
  ));
