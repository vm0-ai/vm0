CREATE TABLE "firewall_access_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"requester_user_id" text NOT NULL,
	"firewall_ref" varchar(64) NOT NULL,
	"permission" varchar(128) NOT NULL,
	"method" varchar(10),
	"path" text,
	"reason" text,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "firewall_access_requests" ADD CONSTRAINT "firewall_access_requests_agent_id_zero_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."zero_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_firewall_access_requests_agent_status" ON "firewall_access_requests" USING btree ("agent_id","status");--> statement-breakpoint
CREATE INDEX "idx_firewall_access_requests_org" ON "firewall_access_requests" USING btree ("org_id");