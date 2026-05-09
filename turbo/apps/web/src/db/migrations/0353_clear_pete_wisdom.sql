CREATE TABLE "user_message_run" (
	"user_message_id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_message_run" ADD CONSTRAINT "user_message_run_user_message_id_chat_messages_id_fk" FOREIGN KEY ("user_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_message_run" ADD CONSTRAINT "user_message_run_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_user_message_run_run_id" ON "user_message_run" USING btree ("run_id");