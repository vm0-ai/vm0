ALTER TABLE "agent_ssh_access" DROP CONSTRAINT "agent_ssh_access_agent_owner_fk";
--> statement-breakpoint
ALTER TABLE "agent_ssh_access" ADD CONSTRAINT "agent_ssh_access_agent_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;