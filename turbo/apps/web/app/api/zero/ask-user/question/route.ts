import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import { zeroAskUserQuestionContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { agentRunCallbacks } from "../../../../../src/db/schema/agent-run-callback";
import { slackOrgInstallations } from "../../../../../src/db/schema/slack-org-installation";
import { slackOrgPendingQuestions } from "../../../../../src/db/schema/slack-org-pending-question";
import { zeroAgents } from "../../../../../src/db/schema/zero-agent";
import { decryptSecretValue } from "../../../../../src/lib/shared/crypto/secrets-encryption";
import {
  createSlackClient,
  postMessage,
} from "../../../../../src/lib/zero/slack/client";
import { buildAskUserQuestionBlocks } from "../../../../../src/lib/zero/slack/blocks";
import { eq } from "drizzle-orm";

interface SlackOrgPayload {
  workspaceId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  connectionId: string;
  agentId: string;
  existingSessionId?: string;
}

function parseSlackPayload(payload: unknown): SlackOrgPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (
    typeof p.workspaceId !== "string" ||
    typeof p.channelId !== "string" ||
    typeof p.threadTs !== "string" ||
    typeof p.messageTs !== "string" ||
    typeof p.connectionId !== "string" ||
    typeof p.agentId !== "string"
  ) {
    return null;
  }
  return p as unknown as SlackOrgPayload;
}

const router = tsr.router(zeroAskUserQuestionContract, {
  postQuestion: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "slack:write",
    });
    if (isAuthError(authCtx)) return authCtx;

    const { runId } = authCtx;
    if (!runId) {
      return {
        status: 400 as const,
        body: {
          error: { message: "No run context available", code: "BAD_REQUEST" },
        },
      };
    }

    // Resolve Slack thread from callback payload
    const callbacks = await globalThis.services.db
      .select({ payload: agentRunCallbacks.payload })
      .from(agentRunCallbacks)
      .where(eq(agentRunCallbacks.runId, runId))
      .limit(1);

    const slackPayload = callbacks[0]
      ? parseSlackPayload(callbacks[0].payload)
      : null;

    if (!slackPayload) {
      return {
        status: 400 as const,
        body: {
          error: {
            message: "No Slack thread found for this run",
            code: "BAD_REQUEST",
          },
        },
      };
    }

    // Look up Slack installation for the workspace
    const [installation] = await globalThis.services.db
      .select()
      .from(slackOrgInstallations)
      .where(
        eq(slackOrgInstallations.slackWorkspaceId, slackPayload.workspaceId),
      )
      .limit(1);

    if (!installation) {
      return {
        status: 400 as const,
        body: {
          error: {
            message: "No Slack installation found for workspace",
            code: "BAD_REQUEST",
          },
        },
      };
    }

    // Resolve agent name for display
    const [agent] = await globalThis.services.db
      .select({ name: zeroAgents.name })
      .from(zeroAgents)
      .where(eq(zeroAgents.id, slackPayload.agentId))
      .limit(1);
    const agentName = agent?.name ?? "Agent";

    // Decrypt bot token and create Slack client
    const { SECRETS_ENCRYPTION_KEY } = globalThis.services.env;
    const botToken = decryptSecretValue(
      installation.encryptedBotToken,
      SECRETS_ENCRYPTION_KEY,
    );
    const client = createSlackClient(botToken);

    // Insert pending question record
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const [pending] = await globalThis.services.db
      .insert(slackOrgPendingQuestions)
      .values({
        runId,
        slackWorkspaceId: slackPayload.workspaceId,
        slackChannelId: slackPayload.channelId,
        slackThreadTs: slackPayload.threadTs,
        connectionId: slackPayload.connectionId,
        composeId: slackPayload.agentId,
        agentName,
        sessionId: slackPayload.existingSessionId ?? null,
        questions: body.questions,
        expiresAt,
      })
      .returning({ id: slackOrgPendingQuestions.id });

    if (!pending) {
      return {
        status: 400 as const,
        body: {
          error: {
            message: "Failed to create pending question",
            code: "BAD_REQUEST",
          },
        },
      };
    }

    // Build Block Kit card and post to Slack thread
    const fallbackText = body.questions
      .map((q) => {
        return q.question;
      })
      .join("\n");
    const blocks = buildAskUserQuestionBlocks(body.questions, pending.id);

    const cardResult = await postMessage(
      client,
      slackPayload.channelId,
      fallbackText || "The agent needs your input.",
      { threadTs: slackPayload.threadTs, blocks },
    );

    // Store message timestamp for future card updates
    if (cardResult.ts) {
      await globalThis.services.db
        .update(slackOrgPendingQuestions)
        .set({ slackMessageTs: cardResult.ts })
        .where(eq(slackOrgPendingQuestions.id, pending.id));
    }

    return {
      status: 200 as const,
      body: { pendingId: pending.id },
    };
  },
});

const handler = createHandler(zeroAskUserQuestionContract, router, {
  errorHandler: createSafeErrorHandler("ask-user-question"),
});

export { handler as POST };
