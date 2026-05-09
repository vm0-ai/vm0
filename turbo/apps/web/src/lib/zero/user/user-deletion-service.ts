import { eq, and, inArray } from "drizzle-orm";
import { logger } from "../../shared/logger";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentRunQueue } from "@vm0/db/schema/agent-run-queue";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { storages } from "@vm0/db/schema/storage";
import { secrets } from "@vm0/db/schema/secret";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { connectors } from "@vm0/db/schema/connector";
import { variables } from "@vm0/db/schema/variable";
import { usageDaily } from "@vm0/db/schema/usage-daily";
import { exportJobs } from "@vm0/db/schema/export-job";
import { zeroAgentSchedules } from "@vm0/db/schema/zero-agent-schedule";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { githubUserLinks } from "@vm0/db/schema/github-user-link";
import { telegramUserLinks } from "@vm0/db/schema/telegram-user-link";
import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { composeJobs } from "@vm0/db/schema/compose-job";
import { connectorSessions } from "@vm0/db/schema/connector-session";
import { deviceCodes } from "@vm0/db/schema/device-codes";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { userCache } from "@vm0/db/schema/user-cache";
import { users } from "@vm0/db/schema/user";
import { publishCancelNotification } from "../../infra/realtime/client";

const log = logger("service:user-deletion");

/**
 * Cancel all pending/running/queued agent runs for a user and notify
 * runners so mitmproxy stops emitting webhooks before the rows are
 * deleted. The Ably publish is best-effort — on failure, the runner
 * continues to natural completion (see publishCancelNotification).
 */
async function cancelUserRuns(userId: string): Promise<void> {
  const db = globalThis.services.db;

  const cancelled = await db
    .update(agentRuns)
    .set({ status: "cancelled", completedAt: new Date() })
    .where(
      and(
        eq(agentRuns.userId, userId),
        inArray(agentRuns.status, ["queued", "pending", "running"]),
      ),
    )
    .returning({ id: agentRuns.id, runnerGroup: agentRuns.runnerGroup });

  await db.delete(agentRunQueue).where(eq(agentRunQueue.userId, userId));

  await Promise.allSettled(
    cancelled
      .filter((r) => {
        return r.runnerGroup !== null;
      })
      .map((r) => {
        return publishCancelNotification(r.runnerGroup!, r.id);
      }),
  );

  log.info("user runs cancelled", { userId, count: cancelled.length });
}

/**
 * Delete all user-scoped data from the database.
 *
 * Idempotent: safe to call multiple times for the same userId.
 */
export async function deleteUserData(userId: string): Promise<void> {
  const db = globalThis.services.db;

  log.info("deleting user data", { userId });

  // Phase 0: Cancel all running work
  await cancelUserRuns(userId);

  // Step 1: Slack cleanup (cascades slack_org_thread_sessions)
  await db
    .delete(slackOrgConnections)
    .where(eq(slackOrgConnections.vm0UserId, userId));

  // Step 2: External service links
  await db.delete(githubUserLinks).where(eq(githubUserLinks.vm0UserId, userId));
  await db
    .delete(telegramUserLinks)
    .where(eq(telegramUserLinks.vm0UserId, userId));

  // Step 3: Aggregate roots with CASCADE (handles ~15 child tables)
  // Delete runs first (references compose_versions with SET NULL)
  await db.delete(agentRuns).where(eq(agentRuns.userId, userId));
  // Then composes (cascades: compose_versions, sessions, chat_threads,
  // email_thread_sessions, github_installations, telegram_installations)
  await db.delete(agentComposes).where(eq(agentComposes.userId, userId));
  // Storages (cascades: storage_versions, storage_version_lineage)
  await db.delete(storages).where(eq(storages.userId, userId));
  // Model providers (some have null secretId, so won't cascade from secrets)
  await db.delete(modelProviders).where(eq(modelProviders.userId, userId));
  // Secrets (cascades remaining model_providers with secretId)
  await db.delete(secrets).where(eq(secrets.userId, userId));

  // Step 4: Tables without CASCADE
  await db.delete(connectors).where(eq(connectors.userId, userId));
  await db.delete(variables).where(eq(variables.userId, userId));
  await db.delete(usageDaily).where(eq(usageDaily.userId, userId));
  await db.delete(exportJobs).where(eq(exportJobs.userId, userId));
  // Cross-org schedules: deleted by userId (not only via compose CASCADE)
  await db
    .delete(zeroAgentSchedules)
    .where(eq(zeroAgentSchedules.userId, userId));

  // Step 5: User-only tables (no orgId)
  await db.delete(cliTokens).where(eq(cliTokens.userId, userId));
  await db.delete(composeJobs).where(eq(composeJobs.userId, userId));
  await db
    .delete(connectorSessions)
    .where(eq(connectorSessions.userId, userId));
  await db.delete(deviceCodes).where(eq(deviceCodes.userId, userId));

  // Step 6: Membership cleanup (all orgs)
  await db.delete(orgMembersCache).where(eq(orgMembersCache.userId, userId));
  await db
    .delete(orgMembersMetadata)
    .where(eq(orgMembersMetadata.userId, userId));

  // Step 7: User identity (LAST)
  await db.delete(userCache).where(eq(userCache.userId, userId));
  await db.delete(users).where(eq(users.id, userId));

  log.info("user data deleted", { userId });
}
