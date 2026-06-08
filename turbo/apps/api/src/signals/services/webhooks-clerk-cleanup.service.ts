import { connectorTypeSchema } from "@vm0/connectors/connectors";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRunQueue } from "@vm0/db/schema/agent-run-queue";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { composeJobs } from "@vm0/db/schema/compose-job";
import { connectorExternalCodeSessions } from "@vm0/db/schema/connector-external-code-session";
import { connectorOauthDeviceAuthorizationSessions } from "@vm0/db/schema/connector-oauth-device-authorization-session";
import { connectors } from "@vm0/db/schema/connector";
import { deviceCodes } from "@vm0/db/schema/device-codes";
import { exportJobs } from "@vm0/db/schema/export-job";
import { githubUserLinks } from "@vm0/db/schema/github-user-link";
import { modelProviderAuthSessions } from "@vm0/db/schema/model-provider-auth-session";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { orgCache } from "@vm0/db/schema/org-cache";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { secrets } from "@vm0/db/schema/secret";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { storages } from "@vm0/db/schema/storage";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { telegramUserLinks } from "@vm0/db/schema/telegram-user-link";
import { usageDaily } from "@vm0/db/schema/usage-daily";
import { userCache } from "@vm0/db/schema/user-cache";
import { users } from "@vm0/db/schema/user";
import { userPermissionGrants } from "@vm0/db/schema/user-permission-grant";
import { variables } from "@vm0/db/schema/variable";
import { zeroAgentSchedules } from "@vm0/db/schema/zero-agent-schedule";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { command, computed, type Computed } from "ccstate";
import { and, eq, inArray, isNotNull } from "drizzle-orm";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { writeDb$, type Db } from "../external/db";
import { deleteS3Objects, listS3Objects } from "../external/s3";
import { nowDate } from "../external/time";
import { publishCancelToRunnerGroup } from "../external/realtime";
import { deleteWebhook } from "../external/telegram-client";
import { getStripeClient } from "../external/stripe-client";
import { settle, tapError } from "../utils";
import { decryptPersistentSecretValue } from "./crypto.utils";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { deleteZeroConnectorLocalState$ } from "./zero-connector-data.service";

const L = logger("WebhookClerkCleanup");

async function publishCancelBestEffort(
  runnerGroup: string | null,
  runId: string,
): Promise<void> {
  if (!runnerGroup) {
    return;
  }
  await tapError(publishCancelToRunnerGroup(runnerGroup, runId), (error) => {
    L.warn("failed to publish run cancellation", {
      runId,
      runnerGroup,
      error,
    });
  });
}

async function cancelOrgRuns(db: Db, orgId: string): Promise<void> {
  const cancelled = await db
    .update(agentRuns)
    .set({ status: "cancelled", completedAt: nowDate() })
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        inArray(agentRuns.status, ["queued", "pending", "running"]),
      ),
    )
    .returning({ id: agentRuns.id, runnerGroup: agentRuns.runnerGroup });

  await db.delete(agentRunQueue).where(eq(agentRunQueue.orgId, orgId));
  await Promise.all(
    cancelled.map((run) => {
      return publishCancelBestEffort(run.runnerGroup, run.id);
    }),
  );
}

async function cancelUserRuns(db: Db, userId: string): Promise<void> {
  const cancelled = await db
    .update(agentRuns)
    .set({ status: "cancelled", completedAt: nowDate() })
    .where(
      and(
        eq(agentRuns.userId, userId),
        inArray(agentRuns.status, ["queued", "pending", "running"]),
      ),
    )
    .returning({ id: agentRuns.id, runnerGroup: agentRuns.runnerGroup });

  await db.delete(agentRunQueue).where(eq(agentRunQueue.userId, userId));
  await Promise.all(
    cancelled.map((run) => {
      return publishCancelBestEffort(run.runnerGroup, run.id);
    }),
  );
}

async function cleanupWorkspaceInstallation(
  db: Db,
  workspaceId: string,
): Promise<void> {
  await db
    .delete(slackOrgConnections)
    .where(eq(slackOrgConnections.slackWorkspaceId, workspaceId));
  await db
    .delete(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, workspaceId));
}

async function cancelStripeSubscription(db: Db, orgId: string): Promise<void> {
  const [meta] = await db
    .select({
      stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
      subscriptionStatus: orgMetadata.subscriptionStatus,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);

  if (!meta?.stripeSubscriptionId || meta.subscriptionStatus === "canceled") {
    return;
  }

  await getStripeClient().subscriptions.cancel(meta.stripeSubscriptionId);
}

async function deregisterOrgTelegramWebhooks(
  db: Db,
  orgId: string,
): Promise<void> {
  const installations = await db
    .select({
      telegramBotId: telegramInstallations.telegramBotId,
      encryptedBotToken: telegramInstallations.encryptedBotToken,
      ownerUserId: telegramInstallations.ownerUserId,
    })
    .from(telegramInstallations)
    .where(eq(telegramInstallations.orgId, orgId));

  for (const installation of installations) {
    await tapError(
      deleteWebhook(
        await decryptPersistentSecretValue(
          installation.encryptedBotToken,
          await loadUserFeatureSwitchContext(
            db,
            orgId,
            installation.ownerUserId,
          ),
        ),
      ),
      (error) => {
        L.warn("failed to deregister telegram webhook", {
          telegramBotId: installation.telegramBotId,
          error,
        });
      },
    );
  }
}

async function deregisterOwnedTelegramWebhooks(
  db: Db,
  userId: string,
): Promise<void> {
  const installations = await db
    .select({
      telegramBotId: telegramInstallations.telegramBotId,
      encryptedBotToken: telegramInstallations.encryptedBotToken,
      orgId: telegramInstallations.orgId,
    })
    .from(telegramInstallations)
    .where(eq(telegramInstallations.ownerUserId, userId));

  for (const installation of installations) {
    await tapError(
      deleteWebhook(
        await decryptPersistentSecretValue(
          installation.encryptedBotToken,
          await loadUserFeatureSwitchContext(db, installation.orgId, userId),
        ),
      ),
      (error) => {
        L.warn("failed to deregister telegram webhook", {
          telegramBotId: installation.telegramBotId,
          error,
        });
      },
    );
  }
}

const revokeOrgConnectorTokens$ = command(
  async (
    { set },
    db: Db,
    orgId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const rows = await db
      .select({ userId: connectors.userId, type: connectors.type })
      .from(connectors)
      .where(eq(connectors.orgId, orgId));
    signal.throwIfAborted();

    for (const row of rows) {
      const parsed = connectorTypeSchema.safeParse(row.type);
      if (!parsed.success) {
        L.warn("unknown connector type, skipping revocation", {
          orgId,
          type: row.type,
        });
        continue;
      }

      await set(
        deleteZeroConnectorLocalState$,
        { orgId, userId: row.userId, type: parsed.data },
        signal,
      );
    }
  },
);

const revokeUserConnectorTokens$ = command(
  async (
    { set },
    db: Db,
    userId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const rows = await db
      .select({ orgId: connectors.orgId, type: connectors.type })
      .from(connectors)
      .where(eq(connectors.userId, userId));
    signal.throwIfAborted();

    for (const row of rows) {
      const parsed = connectorTypeSchema.safeParse(row.type);
      if (!parsed.success) {
        L.warn("unknown connector type, skipping revocation", {
          userId,
          type: row.type,
        });
        continue;
      }

      await set(
        deleteZeroConnectorLocalState$,
        { orgId: row.orgId, userId, type: parsed.data },
        signal,
      );
    }
  },
);

const cleanupOrgExternalServices$ = command(
  async (
    { set },
    db: Db,
    orgId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const steps: readonly {
      readonly name: string;
      readonly run: () => Promise<void>;
    }[] = [
      {
        name: "stripe subscription",
        run: () => {
          return cancelStripeSubscription(db, orgId);
        },
      },
      {
        name: "telegram webhooks",
        run: () => {
          return deregisterOrgTelegramWebhooks(db, orgId);
        },
      },
      {
        name: "connector tokens",
        run: () => {
          return set(revokeOrgConnectorTokens$, db, orgId, signal);
        },
      },
    ];

    for (const step of steps) {
      await tapError(step.run(), (error) => {
        L.warn(`failed to cleanup ${step.name}`, { orgId, error });
      });
      signal.throwIfAborted();
    }
  },
);

const cleanupUserExternalServices$ = command(
  async (
    { set },
    db: Db,
    userId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const steps: readonly {
      readonly name: string;
      readonly run: () => Promise<void>;
    }[] = [
      {
        name: "connector tokens",
        run: () => {
          return set(revokeUserConnectorTokens$, db, userId, signal);
        },
      },
      {
        name: "telegram owned bots",
        run: () => {
          return deregisterOwnedTelegramWebhooks(db, userId);
        },
      },
    ];

    for (const step of steps) {
      await tapError(step.run(), (error) => {
        L.warn(`failed to cleanup ${step.name}`, { userId, error });
      });
      signal.throwIfAborted();
    }
  },
);

function deleteObjectsForPrefixes(
  bucket: string,
  prefixes: readonly string[],
): Computed<Promise<void>> {
  return computed(async (get): Promise<void> => {
    for (const prefix of prefixes) {
      const objects = await get(listS3Objects(bucket, prefix));
      if (objects.length === 0) {
        continue;
      }
      await get(
        deleteS3Objects(
          bucket,
          objects.map((object) => {
            return object.key;
          }),
        ),
      );
    }
  });
}

function deleteUserObjectsForPrefixesBestEffort(
  bucket: string,
  prefixes: readonly string[],
  userId: string,
): Computed<Promise<void>> {
  return computed(async (get): Promise<void> => {
    for (const prefix of prefixes) {
      const objectsResult = await settle(get(listS3Objects(bucket, prefix)));
      if (!objectsResult.ok) {
        L.warn("failed to list user storage objects", {
          userId,
          prefix,
          error: objectsResult.error,
        });
        continue;
      }

      if (objectsResult.value.length === 0) {
        continue;
      }

      const deleteResult = await settle(
        get(
          deleteS3Objects(
            bucket,
            objectsResult.value.map((object) => {
              return object.key;
            }),
          ),
        ),
      );
      if (!deleteResult.ok) {
        L.warn("failed to delete user storage objects", {
          userId,
          prefix,
          error: deleteResult.error,
        });
      }
    }
  });
}

function deleteOrgS3Data(db: Db, orgId: string): Computed<Promise<void>> {
  return computed(async (get): Promise<void> => {
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const storageRows = await db
      .select({ s3Prefix: storages.s3Prefix })
      .from(storages)
      .where(eq(storages.orgId, orgId));
    await get(
      deleteObjectsForPrefixes(
        bucket,
        storageRows.map((row) => {
          return row.s3Prefix;
        }),
      ),
    );

    const exportRows = await db
      .select({ s3Key: exportJobs.s3Key })
      .from(exportJobs)
      .where(and(eq(exportJobs.orgId, orgId), isNotNull(exportJobs.s3Key)));
    const exportKeys = exportRows.flatMap((row) => {
      return row.s3Key ? [row.s3Key] : [];
    });
    await get(deleteS3Objects(bucket, exportKeys));
  });
}

function deleteUserS3Data(db: Db, userId: string): Computed<Promise<void>> {
  return computed(async (get): Promise<void> => {
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const storageRows = await db
      .select({ s3Prefix: storages.s3Prefix })
      .from(storages)
      .where(eq(storages.userId, userId));
    await get(
      deleteUserObjectsForPrefixesBestEffort(
        bucket,
        storageRows.map((row) => {
          return row.s3Prefix;
        }),
        userId,
      ),
    );

    const exportRows = await db
      .select({ s3Key: exportJobs.s3Key })
      .from(exportJobs)
      .where(and(eq(exportJobs.userId, userId), isNotNull(exportJobs.s3Key)));
    const exportKeys = exportRows.flatMap((row) => {
      return row.s3Key ? [row.s3Key] : [];
    });
    const deleteExportsResult = await settle(
      get(deleteS3Objects(bucket, exportKeys)),
    );
    if (!deleteExportsResult.ok) {
      L.warn("failed to delete user export objects", {
        userId,
        count: exportKeys.length,
        error: deleteExportsResult.error,
      });
    }
  });
}

async function deleteOrgData(db: Db, orgId: string): Promise<void> {
  await cancelOrgRuns(db, orgId);

  const installations = await db
    .select({ slackWorkspaceId: slackOrgInstallations.slackWorkspaceId })
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.orgId, orgId));
  for (const installation of installations) {
    await cleanupWorkspaceInstallation(db, installation.slackWorkspaceId);
  }

  await db
    .delete(zeroAgentSchedules)
    .where(eq(zeroAgentSchedules.orgId, orgId));
  await db.delete(agentRuns).where(eq(agentRuns.orgId, orgId));
  await db.delete(agentComposes).where(eq(agentComposes.orgId, orgId));
  await db.delete(storages).where(eq(storages.orgId, orgId));
  await db.delete(modelProviders).where(eq(modelProviders.orgId, orgId));
  await db
    .delete(modelProviderAuthSessions)
    .where(eq(modelProviderAuthSessions.orgId, orgId));
  await db.delete(secrets).where(eq(secrets.orgId, orgId));
  await db.delete(connectors).where(eq(connectors.orgId, orgId));
  await db
    .delete(connectorOauthDeviceAuthorizationSessions)
    .where(eq(connectorOauthDeviceAuthorizationSessions.orgId, orgId));
  await db
    .delete(connectorExternalCodeSessions)
    .where(eq(connectorExternalCodeSessions.orgId, orgId));
  await db.delete(variables).where(eq(variables.orgId, orgId));
  await db.delete(usageDaily).where(eq(usageDaily.orgId, orgId));
  await db.delete(exportJobs).where(eq(exportJobs.orgId, orgId));
  await db.delete(zeroAgents).where(eq(zeroAgents.orgId, orgId));
  await db.delete(orgMembersCache).where(eq(orgMembersCache.orgId, orgId));
  await db
    .delete(orgMembersMetadata)
    .where(eq(orgMembersMetadata.orgId, orgId));
  await db.delete(orgCache).where(eq(orgCache.orgId, orgId));
  await db.delete(orgMetadata).where(eq(orgMetadata.orgId, orgId));
}

async function deleteUserData(db: Db, userId: string): Promise<void> {
  await cancelUserRuns(db, userId);

  await db
    .delete(slackOrgConnections)
    .where(eq(slackOrgConnections.vm0UserId, userId));
  await db.delete(githubUserLinks).where(eq(githubUserLinks.vm0UserId, userId));
  await db
    .delete(telegramUserLinks)
    .where(eq(telegramUserLinks.vm0UserId, userId));
  await db
    .delete(telegramInstallations)
    .where(eq(telegramInstallations.ownerUserId, userId));
  await db.delete(agentRuns).where(eq(agentRuns.userId, userId));

  const composeRows = await db
    .select({ id: agentComposes.id })
    .from(agentComposes)
    .where(eq(agentComposes.userId, userId));
  const composeIds = composeRows.map((row) => {
    return row.id;
  });
  if (composeIds.length > 0) {
    await db
      .delete(agentComposeVersions)
      .where(inArray(agentComposeVersions.composeId, composeIds));
  }

  await db.delete(agentComposes).where(eq(agentComposes.userId, userId));
  await db.delete(storages).where(eq(storages.userId, userId));
  await db.delete(modelProviders).where(eq(modelProviders.userId, userId));
  await db
    .delete(modelProviderAuthSessions)
    .where(eq(modelProviderAuthSessions.userId, userId));
  await db.delete(secrets).where(eq(secrets.userId, userId));
  await db.delete(connectors).where(eq(connectors.userId, userId));
  await db.delete(variables).where(eq(variables.userId, userId));
  await db.delete(usageDaily).where(eq(usageDaily.userId, userId));
  await db.delete(exportJobs).where(eq(exportJobs.userId, userId));
  await db
    .delete(zeroAgentSchedules)
    .where(eq(zeroAgentSchedules.userId, userId));
  await db.delete(cliTokens).where(eq(cliTokens.userId, userId));
  await db.delete(composeJobs).where(eq(composeJobs.userId, userId));
  await db
    .delete(connectorOauthDeviceAuthorizationSessions)
    .where(eq(connectorOauthDeviceAuthorizationSessions.userId, userId));
  await db
    .delete(connectorExternalCodeSessions)
    .where(eq(connectorExternalCodeSessions.userId, userId));
  await db.delete(deviceCodes).where(eq(deviceCodes.userId, userId));
  await db
    .delete(userPermissionGrants)
    .where(eq(userPermissionGrants.userId, userId));
  await db.delete(orgMembersCache).where(eq(orgMembersCache.userId, userId));
  await db
    .delete(orgMembersMetadata)
    .where(eq(orgMembersMetadata.userId, userId));
  await db.delete(userCache).where(eq(userCache.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

export const cleanupClerkDeletedOrg$ = command(
  async ({ get, set }, orgId: string, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    await set(cleanupOrgExternalServices$, db, orgId, signal);
    signal.throwIfAborted();
    await get(deleteOrgS3Data(db, orgId));
    signal.throwIfAborted();
    await deleteOrgData(db, orgId);
  },
);

export const cleanupClerkDeletedUser$ = command(
  async ({ get, set }, userId: string, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    await set(cleanupUserExternalServices$, db, userId, signal);
    signal.throwIfAborted();
    await get(deleteUserS3Data(db, userId));
    signal.throwIfAborted();
    await deleteUserData(db, userId);
  },
);
