CREATE TABLE "slack_user_agent_preferences" (
	"vm0_user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"selected_compose_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "slack_user_agent_preferences_pkey" PRIMARY KEY("vm0_user_id","org_id")
);
--> statement-breakpoint
ALTER TABLE "slack_user_agent_preferences" ADD CONSTRAINT "slack_user_agent_preferences_selected_compose_id_agent_composes_id_fk" FOREIGN KEY ("selected_compose_id") REFERENCES "public"."agent_composes"("id") ON DELETE set null ON UPDATE no action;