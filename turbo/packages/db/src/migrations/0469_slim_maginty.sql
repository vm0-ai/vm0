CREATE TABLE "zero_agent_drafts" (
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"draft_content" text,
	"draft_attachments" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "zero_agent_drafts" ADD CONSTRAINT "zero_agent_drafts_agent_id_zero_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."zero_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_zero_agent_drafts_user_org_agent" ON "zero_agent_drafts" USING btree ("user_id","org_id","agent_id");