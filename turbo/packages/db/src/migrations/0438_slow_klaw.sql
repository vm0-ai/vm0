CREATE TABLE "automation_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"kind" varchar(32) NOT NULL,
	"config" jsonb,
	"webhook_token" varchar(64),
	"encrypted_secret" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" varchar(64) NOT NULL,
	"description" text,
	"instruction" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"interpreter_kind" varchar(32) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_triggers" ADD CONSTRAINT "automation_triggers_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_agent_id_agent_composes_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent_composes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_automation_triggers_automation" ON "automation_triggers" USING btree ("automation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_automation_triggers_webhook_token" ON "automation_triggers" USING btree ("webhook_token");--> statement-breakpoint
CREATE INDEX "idx_automations_agent" ON "automations" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_automations_org" ON "automations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_automations_user_org" ON "automations" USING btree ("user_id","org_id");--> statement-breakpoint
CREATE INDEX "idx_automations_chat_thread" ON "automations" USING btree ("chat_thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_automations_agent_name_org_user" ON "automations" USING btree ("agent_id","name","org_id","user_id");