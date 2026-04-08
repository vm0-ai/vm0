-- Rename firewall_access_requests table to permission_access_requests
ALTER TABLE "firewall_access_requests" RENAME TO "permission_access_requests";

-- Rename firewall_ref column to connector_ref
ALTER TABLE "permission_access_requests" RENAME COLUMN "firewall_ref" TO "connector_ref";

-- Rename indexes
ALTER INDEX "idx_firewall_access_requests_agent_status" RENAME TO "idx_permission_access_requests_agent_status";
ALTER INDEX "idx_firewall_access_requests_org" RENAME TO "idx_permission_access_requests_org";

-- Rename firewall_policies column in zero_agents table
ALTER TABLE "zero_agents" RENAME COLUMN "firewall_policies" TO "permission_policies";
