import {
  createHandler,
  tsr,
} from "../../../../../../../src/lib/ts-rest-handler";
import { integrationsSlackUploadInitContract } from "@vm0/core";
import { initServices } from "../../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../../src/lib/auth/require-auth";
import { isSandboxAuth } from "../../../../../../../src/lib/auth/capability-check";
import { resolveOrg } from "../../../../../../../src/lib/org/resolve-org";
import { agentRuns } from "../../../../../../../src/db/schema/agent-run";
import { slackOrgInstallations } from "../../../../../../../src/db/schema/slack-org-installation";
import { decryptSecretValue } from "../../../../../../../src/lib/crypto/secrets-encryption";
import { createSlackClient } from "../../../../../../../src/lib/slack/client";
import { eq, and } from "drizzle-orm";

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

const router = tsr.router(integrationsSlackUploadInitContract, {
  init: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "slack:write",
    });
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

    // Decrypt bot token and request upload URL from Slack
    const { SECRETS_ENCRYPTION_KEY } = globalThis.services.env;
    const botToken = decryptSecretValue(
      installation.encryptedBotToken,
      SECRETS_ENCRYPTION_KEY,
    );
    const client = createSlackClient(botToken);

    try {
      const result = await client.files.getUploadURLExternal({
        filename: body.filename,
        length: body.length,
      });

      if (!result.ok || !result.upload_url || !result.file_id) {
        return {
          status: 400 as const,
          body: {
            error: {
              message: `Slack API error: ${result.error ?? "unknown error"}`,
              code: "SLACK_ERROR",
            },
          },
        };
      }

      return {
        status: 200 as const,
        body: {
          uploadUrl: result.upload_url,
          fileId: result.file_id,
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

const handler = createHandler(integrationsSlackUploadInitContract, router);

export { handler as POST };
