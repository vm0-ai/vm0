CREATE TABLE "phone_thread_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"agent_session_id" uuid NOT NULL,
	"last_call_id" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phone_user_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_number" varchar(20) NOT NULL,
	"org_id" text NOT NULL,
	"vm0_user_id" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_metadata" ADD COLUMN "agentphone_agent_id" varchar(255);--> statement-breakpoint
ALTER TABLE "org_metadata" ADD COLUMN "agentphone_number_id" varchar(255);--> statement-breakpoint
ALTER TABLE "org_metadata" ADD COLUMN "agentphone_number" varchar(20);--> statement-breakpoint
ALTER TABLE "phone_thread_sessions" ADD CONSTRAINT "phone_thread_sessions_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_phone_thread_sessions_user_org" ON "phone_thread_sessions" USING btree ("user_id","org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_phone_user_links_phone_org" ON "phone_user_links" USING btree ("phone_number","org_id");--> statement-breakpoint
CREATE INDEX "idx_phone_user_links_org_user" ON "phone_user_links" USING btree ("org_id","vm0_user_id");--> statement-breakpoint
CREATE INDEX "idx_phone_user_links_org_phone" ON "phone_user_links" USING btree ("org_id","phone_number");