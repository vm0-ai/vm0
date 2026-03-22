import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import { integrationsSlackMessageContract } from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { isSandboxAuth } from "../../../../../../src/lib/auth/capability-check";
import { resolveOrg } from "../../../../../../src/lib/org/resolve-org";
import { getOrgData } from "../../../../../../src/lib/org/org-cache-service";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { slackOrgInstallations } from "../../../../../../src/db/schema/slack-org-installation";
import { decryptSecretValue } from "../../../../../../src/lib/crypto/secrets-encryption";
import { createSlackClient } from "../../../../../../src/lib/slack/client";
import type { Block, KnownBlock } from "@slack/web-api";
import { eq, and } from "drizzle-orm";

const router = tsr.router(integrationsSlackMessageContract, {
  sendMessage: async ({ body, headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "integration-slack:write",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    // Resolve orgId — sandbox tokens derive from runId, CLI/session use resolveOrg
    let orgId: string;
    if (isSandboxAuth(authCtx)) {
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
      orgId = (await getOrgData(sandboxRun.orgId)).orgId;
    } else {
      const orgSlug = new URL(request.url).searchParams.get("org");
      const { org } = await resolveOrg(authCtx, orgSlug);
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

    try {
      const result = await client.chat.postMessage({
        channel: body.channel,
        text: body.text ?? "",
        ...(body.threadTs !== undefined && { thread_ts: body.threadTs }),
        ...(body.blocks !== undefined && {
          blocks: body.blocks as (Block | KnownBlock)[],
        }),
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
      const slackError = (error as { data?: { error?: string } }).data?.error;
      if (slackError) {
        return {
          status: 400 as const,
          body: {
            error: {
              message: `Slack API error: ${slackError}`,
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
