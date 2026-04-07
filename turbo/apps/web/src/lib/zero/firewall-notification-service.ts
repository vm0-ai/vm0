import { eq, and } from "drizzle-orm";
import { CONNECTOR_TYPES } from "@vm0/core";
import { slackOrgInstallations } from "../../db/schema/slack-org-installation";
import { slackOrgConnections } from "../../db/schema/slack-org-connection";
import { env } from "../../env";
import { decryptSecretValue } from "../shared/crypto/secrets-encryption";
import { createSlackClient, postMessage } from "./slack/client";
import { getAppUrl } from "./url";
import { logger } from "../shared/logger";

import type { WebClient } from "@slack/web-api";

const log = logger("zero:firewall-notification");

interface SlackDmTarget {
  client: WebClient;
  slackUserId: string;
}

/**
 * Resolve the Slack DM target for a user in an org.
 *
 * Returns `null` when the org has no Slack installation or the user has no
 * Slack connection — callers should silently skip in that case.
 */
async function resolveSlackDmTarget(
  orgId: string,
  clerkUserId: string,
): Promise<SlackDmTarget | null> {
  const db = globalThis.services.db;

  const [installation] = await db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.orgId, orgId))
    .limit(1);

  if (!installation) {
    return null;
  }

  const [connection] = await db
    .select()
    .from(slackOrgConnections)
    .where(
      and(
        eq(slackOrgConnections.vm0UserId, clerkUserId),
        eq(slackOrgConnections.slackWorkspaceId, installation.slackWorkspaceId),
      ),
    )
    .limit(1);

  if (!connection) {
    return null;
  }

  const { SECRETS_ENCRYPTION_KEY } = env();
  const botToken = decryptSecretValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);

  return { client, slackUserId: connection.slackUserId };
}

function buildReviewUrl(agentId: string, requestId: string): string {
  const appUrl = getAppUrl();
  return `${appUrl}/agents/${agentId}/permissions?request=${requestId}`;
}

function connectorLabel(firewallRef: string): string {
  const config = CONNECTOR_TYPES[firewallRef as keyof typeof CONNECTOR_TYPES];
  return config?.label ?? firewallRef;
}

/**
 * Send a Slack DM to the agent owner when a firewall access request is
 * created or re-sent. Fire-and-forget — never throws.
 */
export async function notifyOwnerOfRequest(params: {
  orgId: string;
  ownerUserId: string;
  agentId: string;
  requestId: string;
  agentDisplayName: string;
  requesterName: string;
  permission: string;
  firewallRef: string;
  action: string;
  reason?: string | null;
}): Promise<void> {
  try {
    const target = await resolveSlackDmTarget(params.orgId, params.ownerUserId);
    if (!target) {
      return;
    }

    const label = connectorLabel(params.firewallRef);
    const url = buildReviewUrl(params.agentId, params.requestId);
    const lines = [
      `${params.requesterName} is requesting to ${params.action} "${params.permission}" on ${label} for agent ${params.agentDisplayName}.`,
    ];
    if (params.reason) {
      lines.push(`Reason: ${params.reason}`);
    }
    lines.push(`<${url}|Review request>`);

    await postMessage(target.client, target.slackUserId, lines.join("\n"));
  } catch (err) {
    log.error("Failed to notify owner of firewall request", { err });
  }
}

/**
 * Send a Slack DM to the requester when a firewall access request is
 * approved or rejected. Fire-and-forget — never throws.
 */
export async function notifyRequesterOfResolution(params: {
  orgId: string;
  requestId: string;
  agentId: string;
  agentDisplayName: string;
  requesterUserId: string;
  permission: string;
  firewallRef: string;
  action: string;
  resolution: "approve" | "reject";
}): Promise<void> {
  try {
    const target = await resolveSlackDmTarget(
      params.orgId,
      params.requesterUserId,
    );
    if (!target) {
      return;
    }

    const label = connectorLabel(params.firewallRef);
    const url = buildReviewUrl(params.agentId, params.requestId);
    const outcome = params.resolution === "approve" ? "approved" : "denied";
    const text = `Your request to ${params.action} "${params.permission}" on ${label} for agent ${params.agentDisplayName} has been ${outcome}. <${url}|View>`;

    await postMessage(target.client, target.slackUserId, text);
  } catch (err) {
    log.error("Failed to notify requester of firewall resolution", { err });
  }
}
