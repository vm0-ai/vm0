CREATE TABLE "voice_chat_preparations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" uuid,
	"mode" varchar(20) DEFAULT 'chat' NOT NULL,
	"prompt" text,
	"run_id" uuid,
	"directive_content" text,
	"status" varchar(20) DEFAULT 'preparing' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "voice_chat_preparations" ADD CONSTRAINT "voice_chat_preparations_agent_id_agent_composes_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent_composes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_chat_preparations" ADD CONSTRAINT "voice_chat_preparations_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_voice_chat_preparations_user_agent" ON "voice_chat_preparations" USING btree ("user_id","agent_id","mode");