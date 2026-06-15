CREATE TABLE "github_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"installation_id" varchar(255) NOT NULL,
	"encrypted_access_token" text NOT NULL,
	"default_compose_id" uuid NOT NULL,
	"repo_configs" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "github_installations_installation_id_unique" UNIQUE("installation_id")
);
--> statement-breakpoint
CREATE TABLE "github_issue_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"installation_id" uuid NOT NULL,
	"repo" varchar(255) NOT NULL,
	"issue_number" integer NOT NULL,
	"agent_session_id" uuid NOT NULL,
	"last_comment_id" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_default_compose_id_agent_composes_id_fk" FOREIGN KEY ("default_compose_id") REFERENCES "public"."agent_composes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_issue_sessions" ADD CONSTRAINT "github_issue_sessions_installation_id_github_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."github_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_issue_sessions" ADD CONSTRAINT "github_issue_sessions_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_github_issue_sessions_installation_repo_issue" ON "github_issue_sessions" USING btree ("installation_id","repo","issue_number");--> statement-breakpoint
CREATE INDEX "idx_github_issue_sessions_installation" ON "github_issue_sessions" USING btree ("installation_id");