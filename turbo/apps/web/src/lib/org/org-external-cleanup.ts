import { eq } from "drizzle-orm";
import type { ConnectorType } from "@vm0/core";
import { logger } from "../logger";
import { getStripe } from "../stripe";
import { deleteWebhook } from "../telegram/client";
import { decryptSecretValue } from "../crypto/secrets-encryption";
import { revokeConnectorToken } from "../connector/connector-service";
import { cleanupWorkspaceInstallation } from "../slack-org/connect-service";
import { orgMetadata } from "../../db/schema/org-metadata";
import { telegramInstallations } from "../../db/schema/telegram-installation";
import { agentComposes } from "../../db/schema/agent-compose";
import { connectors } from "../../db/schema/connector";
import { slackOrgInstallations } from "../../db/schema/slack-org-installation";

const log = logger("service:org-external-cleanup");

/**
 * Best-effort cleanup of external services for a deleted org.
 * Must be called BEFORE database deletion — reads tokens/IDs from DB.
 * All operations are best-effort: failures are logged but do not throw.
 * Idempotent: safe to call multiple times.
 */
export async function cleanupOrgExternalServices(orgId: string): Promise<void> {
  await cancelStripeSubscription(orgId);
  await deregisterTelegramWebhooks(orgId);
  await revokeOrgConnectorTokens(orgId);
  await cleanupOrgSlackInstallation(orgId);
}

async function cancelStripeSubscription(orgId: string): Promise<void> {
  try {
    const db = globalThis.services.db;
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

    const stripe = getStripe();
    await stripe.subscriptions.cancel(meta.stripeSubscriptionId);
    log.info("stripe subscription cancelled", {
      orgId,
      subId: meta.stripeSubscriptionId,
    });
  } catch (error) {
    log.error("failed to cancel stripe subscription (best-effort)", {
      orgId,
      error,
    });
  }
}

async function deregisterTelegramWebhooks(orgId: string): Promise<void> {
  try {
    const db = globalThis.services.db;
    const installations = await db
      .select({
        id: telegramInstallations.id,
        encryptedBotToken: telegramInstallations.encryptedBotToken,
      })
      .from(telegramInstallations)
      .innerJoin(
        agentComposes,
        eq(telegramInstallations.defaultComposeId, agentComposes.id),
      )
      .where(eq(agentComposes.orgId, orgId));

    const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;

    for (const inst of installations) {
      try {
        const botToken = decryptSecretValue(
          inst.encryptedBotToken,
          encryptionKey,
        );
        await deleteWebhook(botToken);
        log.debug("telegram webhook deregistered", {
          installationId: inst.id,
        });
      } catch (error) {
        log.error("failed to deregister telegram webhook (best-effort)", {
          installationId: inst.id,
          error,
        });
      }
    }
  } catch (error) {
    log.error("failed to query telegram installations (best-effort)", {
      orgId,
      error,
    });
  }
}

async function revokeOrgConnectorTokens(orgId: string): Promise<void> {
  try {
    const db = globalThis.services.db;
    const orgConnectors = await db
      .select({ userId: connectors.userId, type: connectors.type })
      .from(connectors)
      .where(eq(connectors.orgId, orgId));

    for (const conn of orgConnectors) {
      try {
        await revokeConnectorToken(
          orgId,
          conn.userId,
          conn.type as ConnectorType,
        );
      } catch (error) {
        log.error("failed to revoke connector token (best-effort)", {
          orgId,
          userId: conn.userId,
          type: conn.type,
          error,
        });
      }
    }
  } catch (error) {
    log.error("failed to query connectors (best-effort)", { orgId, error });
  }
}

async function cleanupOrgSlackInstallation(orgId: string): Promise<void> {
  try {
    const db = globalThis.services.db;
    const [installation] = await db
      .select({
        slackWorkspaceId: slackOrgInstallations.slackWorkspaceId,
      })
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.orgId, orgId))
      .limit(1);

    if (!installation) return;

    await cleanupWorkspaceInstallation(installation.slackWorkspaceId);
    log.info("slack workspace installation cleaned up", { orgId });
  } catch (error) {
    log.error("failed to cleanup slack installation (best-effort)", {
      orgId,
      error,
    });
  }
}
