ALTER TABLE "zero_agents" RENAME COLUMN "firewall_policies" TO "permission_policies";
ALTER TABLE "firewall_access_requests" RENAME TO "permission_access_requests";
ALTER TABLE "permission_access_requests" RENAME COLUMN "firewall_ref" TO "connector_ref";
ALTER INDEX "idx_firewall_access_requests_agent_status" RENAME TO "idx_permission_access_requests_agent_status";
ALTER INDEX "idx_firewall_access_requests_org" RENAME TO "idx_permission_access_requests_org";
ALTER INDEX "firewall_access_requests_pkey" RENAME TO "permission_access_requests_pkey";
ALTER TABLE "permission_access_requests" RENAME CONSTRAINT "firewall_access_requests_agent_id_zero_agents_id_fk" TO "permission_access_requests_agent_id_zero_agents_id_fk";
