import { eq } from "drizzle-orm";
import { connectorTypeSchema } from "@vm0/core";
import { logger } from "../../shared/logger";
import { revokeConnectorToken } from "../connector/connector-service";
import { connectors } from "../../../db/schema/connector";
import { githubUserLinks } from "../../../db/schema/github-user-link";
import { telegramUserLinks } from "../../../db/schema/telegram-user-link";
import { slackOrgConnections } from "../../../db/schema/slack-org-connection";

const log = logger("service:user-external-cleanup");

/**
 * Best-effort cleanup of external services for a deleted user.
 * Must be called BEFORE database deletion — reads tokens/IDs from DB.
 * All operations are best-effort: failures are logged but do not throw.
 * Idempotent: safe to call multiple times.
 */
export async function cleanupUserExternalServices(
  userId: string,
): Promise<void> {
  const steps = [
    {
      name: "connector tokens",
      fn: () => {
        return revokeUserConnectorTokens(userId);
      },
    },
    {
      name: "github links",
      fn: () => {
        return deleteGitHubUserLinks(userId);
      },
    },
    {
      name: "telegram links",
      fn: () => {
        return deleteTelegramUserLinks(userId);
      },
    },
    {
      name: "slack connections",
      fn: () => {
        return deleteUserSlackConnections(userId);
      },
    },
  ];

  for (const step of steps) {
    try {
      await step.fn();
    } catch (error) {
      log.error(`failed to cleanup ${step.name} (best-effort)`, {
        userId,
        error,
      });
    }
  }
}

async function revokeUserConnectorTokens(userId: string): Promise<void> {
  const db = globalThis.services.db;
  const userConnectors = await db
    .select({ orgId: connectors.orgId, type: connectors.type })
    .from(connectors)
    .where(eq(connectors.userId, userId));

  for (const conn of userConnectors) {
    try {
      const parsed = connectorTypeSchema.safeParse(conn.type);
      if (!parsed.success) {
        log.warn("unknown connector type, skipping revocation", {
          userId,
          type: conn.type,
        });
        continue;
      }
      await revokeConnectorToken(conn.orgId, userId, parsed.data);
    } catch (error) {
      log.error("failed to revoke connector token (best-effort)", {
        userId,
        orgId: conn.orgId,
        type: conn.type,
        error,
      });
    }
  }
}

async function deleteGitHubUserLinks(userId: string): Promise<void> {
  const db = globalThis.services.db;
  const result = await db
    .delete(githubUserLinks)
    .where(eq(githubUserLinks.vm0UserId, userId));
  if (result.rowCount && result.rowCount > 0) {
    log.debug("deleted github user links", {
      userId,
      count: result.rowCount,
    });
  }
}

async function deleteTelegramUserLinks(userId: string): Promise<void> {
  const db = globalThis.services.db;
  const result = await db
    .delete(telegramUserLinks)
    .where(eq(telegramUserLinks.vm0UserId, userId));
  if (result.rowCount && result.rowCount > 0) {
    log.debug("deleted telegram user links", {
      userId,
      count: result.rowCount,
    });
  }
}

async function deleteUserSlackConnections(userId: string): Promise<void> {
  const db = globalThis.services.db;

  // Find all connections for this user
  const connections = await db
    .select({ id: slackOrgConnections.id })
    .from(slackOrgConnections)
    .where(eq(slackOrgConnections.vm0UserId, userId));

  if (connections.length === 0) return;

  const connectionIds = connections.map((c) => {
    return c.id;
  });

  // Delete connections (cascades slack_org_thread_sessions)
  await db
    .delete(slackOrgConnections)
    .where(eq(slackOrgConnections.vm0UserId, userId));

  log.debug("deleted slack connections", {
    userId,
    count: connections.length,
  });
}
