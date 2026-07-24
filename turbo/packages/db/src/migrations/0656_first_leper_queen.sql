CREATE TABLE "feishu_org_events" (
	"installation_id" uuid NOT NULL,
	"event_id" varchar(255) NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "feishu_org_events_pkey" PRIMARY KEY("installation_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "feishu_user_agent_preferences" (
	"vm0_user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"selected_compose_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "feishu_user_agent_preferences_pkey" PRIMARY KEY("vm0_user_id","org_id")
);
--> statement-breakpoint
ALTER TABLE "feishu_org_installations" ADD COLUMN "bot_open_id" varchar(255);--> statement-breakpoint
ALTER TABLE "feishu_org_events" ADD CONSTRAINT "feishu_org_events_installation_id_feishu_org_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."feishu_org_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feishu_user_agent_preferences" ADD CONSTRAINT "feishu_user_agent_preferences_selected_compose_id_agent_composes_id_fk" FOREIGN KEY ("selected_compose_id") REFERENCES "public"."agent_composes"("id") ON DELETE set null ON UPDATE no action;