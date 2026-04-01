import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import { integrationsSlackMessageContract } from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { isSandboxAuth } from "../../../../../../src/lib/auth/capability-check";
import { resolveOrg } from "../../../../../../src/lib/org/resolve-org";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { agentComposeVersions } from "../../../../../../src/db/schema/agent-compose";
import { zeroAgents } from "../../../../../../src/db/schema/zero-agent";
import { slackOrgInstallations } from "../../../../../../src/db/schema/slack-org-installation";
import { decryptSecretValue } from "../../../../../../src/lib/crypto/secrets-encryption";
import {
  createSlackClient,
  postMessage,
} from "../../../../../../src/lib/slack/client";
import { buildFooterBlocks } from "../../../../../../src/lib/slack/blocks";
import type { Block, KnownBlock } from "@slack/web-api";
import { eq, and } from "drizzle-orm";

/** Best-effort agent display name resolution from a run ID. */
async function resolveAgentLabel(runId: string): Promise<string | undefined> {
  const [row] = await globalThis.services.db
    .select({
      displayName: zeroAgents.displayName,
      name: zeroAgents.name,
    })
    .from(agentRuns)
    .innerJoin(
      agentComposeVersions,
      eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
    )
    .innerJoin(zeroAgents, eq(agentComposeVersions.composeId, zeroAgents.id))
    .where(eq(agentRuns.id, runId))
    .limit(1);
  return row?.displayName ?? row?.name;
}

/** Type guard for Slack API platform errors that carry a `data.error` string */
function isSlackPlatformError(
  err: unknown,
): err is Error & { data: { error: string } } {
  if (!(err instanceof Error) || !("data" in err)) return false;
  const { data } = err as { data: unknown };
  return (
    typeof data === "object" &&
    data !== null &&
    "error" in data &&
    typeof (data as { error: unknown }).error === "string"
  );
}

const router = tsr.router(integrationsSlackMessageContract, {
  sendMessage: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "slack:write",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    // Resolve orgId — zero tokens carry orgId directly, sandbox tokens derive from runId
    let orgId: string;
    if (authCtx.orgId) {
      orgId = authCtx.orgId;
    } else if (isSandboxAuth(authCtx)) {
      const [sandboxRun] = await globalThis.services.db
        .select({ orgId: agentRuns.orgId })
        .from(agentRuns)
        .where(
          and(eq(agentRuns.id, authCtx.runId), eq(agentRuns.userId, userId)),
        )
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

    // Decrypt bot token and send message
    const { SECRETS_ENCRYPTION_KEY } = globalThis.services.env;
    const botToken = decryptSecretValue(
      installation.encryptedBotToken,
      SECRETS_ENCRYPTION_KEY,
    );
    const client = createSlackClient(botToken);

    // Resolve agent name for "Sent via" footer (best-effort)
    const agentLabel = authCtx.runId
      ? await resolveAgentLabel(authCtx.runId).catch(() => {
          return undefined;
        })
      : undefined;

    // Append "Sent via <agent>" footer blocks when agent is known
    let finalBlocks = body.blocks as (Block | KnownBlock)[] | undefined;
    if (agentLabel) {
      const footerBlocks = buildFooterBlocks(`Sent via ${agentLabel}`);
      if (finalBlocks && finalBlocks.length > 0) {
        finalBlocks = [...finalBlocks, ...footerBlocks];
      } else if (body.text) {
        // Text-only message — wrap text in a section block so Slack renders it
        // (when blocks are present, Slack ignores the text field for display)
        finalBlocks = [
          { type: "section", text: { type: "mrkdwn", text: body.text } },
          ...footerBlocks,
        ];
      } else {
        finalBlocks = footerBlocks;
      }
    }

    try {
      const result = await postMessage(client, body.channel, body.text ?? "", {
        threadTs: body.threadTs,
        blocks: finalBlocks,
      });
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          ts: result.ts,
          channel: result.channel,
        },
      };
    } catch (error) {
      if (isSlackPlatformError(error)) {
        return {
          status: 400 as const,
          body: {
            error: {
              message: `Slack API error: ${error.data.error}`,
              code: "SLACK_ERROR",
            },
          },
        };
      }
      throw error;
    }
  },
});

const handler = createHandler(integrationsSlackMessageContract, router);

export { handler as POST };
