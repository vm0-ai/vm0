CREATE TABLE "mcp_agent_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"allow_all_tools" boolean NOT NULL,
	"allowed_tool_names" text[] NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_mcp_agent_grants_tool_policy" CHECK ((("mcp_agent_grants"."allow_all_tools" AND cardinality("mcp_agent_grants"."allowed_tool_names") = 0) OR (NOT "mcp_agent_grants"."allow_all_tools" AND cardinality("mcp_agent_grants"."allowed_tool_names") > 0)))
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"ref" varchar(64) NOT NULL,
	"display_name" varchar(128) NOT NULL,
	"endpoint" varchar(2048) NOT NULL,
	"enabled" boolean NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_agent_grants" ADD CONSTRAINT "mcp_agent_grants_agent_id_zero_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."zero_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_agent_grants" ADD CONSTRAINT "mcp_agent_grants_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_mcp_agent_grants_scope" ON "mcp_agent_grants" USING btree ("org_id","user_id","agent_id","server_id");--> statement-breakpoint
CREATE INDEX "idx_mcp_agent_grants_agent_id" ON "mcp_agent_grants" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_mcp_agent_grants_server_id" ON "mcp_agent_grants" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_mcp_servers_org_ref" ON "mcp_servers" USING btree ("org_id","ref");