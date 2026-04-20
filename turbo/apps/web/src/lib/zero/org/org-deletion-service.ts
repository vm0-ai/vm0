import { eq, and, inArray } from "drizzle-orm";
import { logger } from "../../shared/logger";
import { agentRuns } from "../../../db/schema/agent-run";
import { agentRunQueue } from "../../../db/schema/agent-run-queue";
import { agentComposes } from "../../../db/schema/agent-compose";
import { storages } from "../../../db/schema/storage";
import { secrets } from "../../../db/schema/secret";
import { modelProviders } from "../../../db/schema/model-provider";
import { connectors } from "../../../db/schema/connector";
import { variables } from "../../../db/schema/variable";
import { usageDaily } from "../../../db/schema/usage-daily";
import { exportJobs } from "../../../db/schema/export-job";
import { zeroAgents } from "../../../db/schema/zero-agent";
import { zeroAgentSchedules } from "../../../db/schema/zero-agent-schedule";
import { slackOrgInstallations } from "../../../db/schema/slack-org-installation";
import { orgMembersCache } from "../../../db/schema/org-members-cache";
import { orgMembersMetadata } from "../../../db/schema/org-members-metadata";
import { orgCache } from "../../../db/schema/org-cache";
import { orgMetadata } from "../../../db/schema/org-metadata";
import { cleanupWorkspaceInstallation } from "../slack-org/connect-service";

const log = logger("service:org-deletion");

/**
 * Cancel all pending/running/queued agent runs for an org.
 * Bulk cancel only updates status — no side effects needed since the
 * entire org is being deleted.
 */
async function cancelOrgRuns(orgId: string): Promise<void> {
  const db = globalThis.services.db;

  const result = await db
    .update(agentRuns)
    .set({ status: "cancelled", completedAt: new Date() })
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        inArray(agentRuns.status, ["queued", "pending", "running"]),
      ),
    );

  await db.delete(agentRunQueue).where(eq(agentRunQueue.orgId, orgId));

  log.info("org runs cancelled", { orgId, count: result.rowCount });
}

/**
 * Delete all org-scoped data from the database.
 * Must be called AFTER external service cleanup (Phase 1) and S3 cleanup (Phase 2),
 * because those phases need to read data from the DB.
 *
 * Idempotent: safe to call multiple times for the same orgId.
 */
export async function deleteOrgData(orgId: string): Promise<void> {
  const db = globalThis.services.db;

  log.info("deleting org data", { orgId });

  // Phase 0: Cancel all running work
  await cancelOrgRuns(orgId);

  // Phase 3: Database cleanup (order matters — children before parents)

  // Step 1: Slack cleanup
  const installations = await db
    .select({ slackWorkspaceId: slackOrgInstallations.slackWorkspaceId })
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.orgId, orgId));

  for (const inst of installations) {
    await cleanupWorkspaceInstallation(inst.slackWorkspaceId);
  }

  // Step 2: Aggregate roots with CASCADE (handles ~15 child tables)
  // Schedules first: lastRunId FK (no CASCADE) blocks agent_runs deletion
  await db
    .delete(zeroAgentSchedules)
    .where(eq(zeroAgentSchedules.orgId, orgId));
  // Delete runs (references compose_versions with SET NULL)
  // creditUsage.runId is SET NULL — billing records preserved permanently
  await db.delete(agentRuns).where(eq(agentRuns.orgId, orgId));
  // Then composes (cascades: compose_versions, sessions, email_thread_sessions)
  await db.delete(agentComposes).where(eq(agentComposes.orgId, orgId));
  // Storages (cascades: storage_versions, storage_version_lineage)
  await db.delete(storages).where(eq(storages.orgId, orgId));
  // Model providers (some have null secretId, so won't cascade from secrets)
  await db.delete(modelProviders).where(eq(modelProviders.orgId, orgId));
  // Secrets (cascades remaining model_providers with secretId)
  await db.delete(secrets).where(eq(secrets.orgId, orgId));

  // Step 3: Tables without CASCADE
  await db.delete(connectors).where(eq(connectors.orgId, orgId));
  await db.delete(variables).where(eq(variables.orgId, orgId));
  await db.delete(usageDaily).where(eq(usageDaily.orgId, orgId));
  await db.delete(exportJobs).where(eq(exportJobs.orgId, orgId));
  await db.delete(zeroAgents).where(eq(zeroAgents.orgId, orgId));

  // Step 4: Membership tables
  await db.delete(orgMembersCache).where(eq(orgMembersCache.orgId, orgId));
  await db
    .delete(orgMembersMetadata)
    .where(eq(orgMembersMetadata.orgId, orgId));

  // Step 5: Org identity (LAST)
  await db.delete(orgCache).where(eq(orgCache.orgId, orgId));
  await db.delete(orgMetadata).where(eq(orgMetadata.orgId, orgId));

  log.info("org data deleted", { orgId });
}
