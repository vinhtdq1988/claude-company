CREATE TABLE "budget_warning_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scope_kind" "policy_scope_kind" NOT NULL,
	"scope_id" uuid NOT NULL,
	"period" text NOT NULL,
	"metric" text NOT NULL,
	"limit_value" numeric(18, 6) NOT NULL,
	"threshold" numeric(4, 3) NOT NULL,
	CONSTRAINT "budget_warning_log_unique" UNIQUE("company_id","scope_kind","scope_id","period","metric","limit_value","threshold"),
	CONSTRAINT "budget_warning_log_metric" CHECK ("budget_warning_log"."metric" in ('tokens', 'cost'))
);
--> statement-breakpoint
-- RLS theo company_id như mọi bảng nghiệp vụ.
SELECT enable_company_rls('budget_warning_log'::regclass);
