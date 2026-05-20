import type { WebClient } from "@slack/web-api";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import { requireAuth, isAuthError } from "../../auth/require-auth";
import { isSandboxAuth } from "../../auth/capability-check";
import { resolveOrg } from "../org/resolve-org";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { decryptPersistentSecretValue } from "../../shared/crypto/kms-secrets-encryption";
import { createSlackClient } from "./client";
import { eq, and } from "drizzle-orm";

type ApiErrorResponse = {
  status: 401 | 403 | 404;
  body: { error: { message: string; code: string } };
};

type SlackClientResult = {
  userId: string;
  orgId: string;
  client: WebClient;
  botToken: string;
  authRunId: string | undefined;
};

/**
 * Authenticate the request, resolve the org, look up the Slack installation,
 * decrypt the bot token, and return a ready-to-use Slack WebClient.
 *
 * Returns either a `SlackClientResult` on success or an `ApiErrorResponse`
 * that the caller can return directly from a ts-rest handler.
 */
export async function resolveSlackClient(
  authHeader: string | undefined,
  requiredCapability: ZeroCapability,
): Promise<SlackClientResult | ApiErrorResponse> {
  const authCtx = await requireAuth(authHeader, { requiredCapability });
  if (isAuthError(authCtx)) return authCtx;
  const { userId } = authCtx;

  // Resolve orgId
  let orgId: string;
  if (authCtx.orgId) {
    orgId = authCtx.orgId;
  } else if (isSandboxAuth(authCtx)) {
    const [sandboxRun] = await globalThis.services.db
      .select({ orgId: agentRuns.orgId })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, authCtx.runId), eq(agentRuns.userId, userId)))
      .limit(1);
    if (!sandboxRun) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent run not found", code: "NOT_FOUND" },
        },
      };
    }
    orgId = sandboxRun.orgId;
  } else {
    const { org } = await resolveOrg(authCtx);
    orgId = org.orgId;
  }

  // Look up Slack installation for the org
  const [installation] = await globalThis.services.db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.orgId, orgId))
    .limit(1);

  if (!installation) {
    return {
      status: 404 as const,
      body: {
        error: {
          message: "No Slack installation found for this organization",
          code: "NOT_FOUND",
        },
      },
    };
  }

  // Decrypt bot token and create Slack client
  const botToken = await decryptPersistentSecretValue(
    installation.encryptedBotToken,
  );
  const client = createSlackClient(botToken);

  return { userId, orgId, client, botToken, authRunId: authCtx.runId };
}

/**
 * Type guard to check if the result of `resolveSlackClient` is an error response.
 */
export function isSlackClientError(
  result: SlackClientResult | ApiErrorResponse,
): result is ApiErrorResponse {
  return "status" in result && "body" in result && !("client" in result);
}
