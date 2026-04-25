import { eq } from "drizzle-orm";
import { connectorTypeSchema } from "@vm0/api-contracts/contracts/connectors";
import { logger } from "../../shared/logger";
import { getStripe } from "../stripe";
import { deleteWebhook } from "../telegram/client";
import { decryptSecretValue } from "../../shared/crypto/secrets-encryption";
import { revokeConnectorToken } from "../connector/connector-service";
import { cleanupWorkspaceInstallation } from "../slack-org/connect-service";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { connectors } from "@vm0/db/schema/connector";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";

const log = logger("service:org-external-cleanup");

/**
 * Best-effort cleanup of external services for a deleted org.
 * Must be called BEFORE database deletion — reads tokens/IDs from DB.
 * All operations are best-effort: failures are logged but do not throw.
 * Idempotent: safe to call multiple times.
 */
export async function cleanupOrgExternalServices(orgId: string): Promise<void> {
  const steps = [
    {
      name: "stripe subscription",
      fn: () => {
        return cancelStripeSubscription(orgId);
      },
    },
    {
      name: "telegram webhooks",
      fn: () => {
        return deregisterTelegramWebhooks(orgId);
      },
    },
    {
      name: "connector tokens",
      fn: () => {
        return revokeOrgConnectorTokens(orgId);
      },
    },
    {
      name: "slack installation",
      fn: () => {
        return cleanupOrgSlackInstallation(orgId);
      },
    },
  ];

  for (const step of steps) {
    try {
      await step.fn();
    } catch (error) {
      log.error(`failed to cleanup ${step.name} (best-effort)`, {
        orgId,
        error,
      });
    }
  }
}

async function cancelStripeSubscription(orgId: string): Promise<void> {
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
}

async function deregisterTelegramWebhooks(orgId: string): Promise<void> {
  const db = globalThis.services.db;
  const installations = await db
    .select({
      telegramBotId: telegramInstallations.telegramBotId,
      encryptedBotToken: telegramInstallations.encryptedBotToken,
    })
    .from(telegramInstallations)
    .where(eq(telegramInstallations.orgId, orgId));

  const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;

  for (const inst of installations) {
    try {
      const botToken = decryptSecretValue(
        inst.encryptedBotToken,
        encryptionKey,
      );
      await deleteWebhook(botToken);
      log.debug("telegram webhook deregistered", {
        telegramBotId: inst.telegramBotId,
      });
    } catch (error) {
      log.error("failed to deregister telegram webhook (best-effort)", {
        telegramBotId: inst.telegramBotId,
        error,
      });
    }
  }
}

async function revokeOrgConnectorTokens(orgId: string): Promise<void> {
  const db = globalThis.services.db;
  const orgConnectors = await db
    .select({ userId: connectors.userId, type: connectors.type })
    .from(connectors)
    .where(eq(connectors.orgId, orgId));

  for (const conn of orgConnectors) {
    try {
      const parsed = connectorTypeSchema.safeParse(conn.type);
      if (!parsed.success) {
        log.warn("unknown connector type, skipping revocation", {
          orgId,
          type: conn.type,
        });
        continue;
      }
      await revokeConnectorToken(orgId, conn.userId, parsed.data);
    } catch (error) {
      log.error("failed to revoke connector token (best-effort)", {
        orgId,
        userId: conn.userId,
        type: conn.type,
        error,
      });
    }
  }
}

async function cleanupOrgSlackInstallation(orgId: string): Promise<void> {
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
}
