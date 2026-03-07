import { eq, desc } from "drizzle-orm";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../db/schema/agent-compose";
import { createRun } from "../../run";
import { isConcurrentRunLimit } from "../../errors";
import { logger } from "../../logger";
import { generateCallbackSecret, getApiUrl } from "../../callback";

const log = logger("telegram:run-agent");

/**
 * Telegram-specific context to include in the callback payload
 */
export interface TelegramCallbackContext {
  installationId: string;
  chatId: string;
  messageId: string;
  rootMessageId: string | null;
  userLinkId: string;
  agentName: string;
  composeId: string;
  existingSessionId: string | null;
  isDM: boolean;
  thinkingMessageId: string | null;
}

interface RunAgentParams {
  composeId: string;
  agentName: string;
  sessionId: string | undefined;
  prompt: string;
  threadContext: string;
  userId: string;
  callbackContext: TelegramCallbackContext;
}

interface RunAgentResult {
  status: "dispatched" | "failed";
  response?: string;
  runId: string | undefined;
}

/**
 * Execute an agent run for Telegram
 *
 * Creates a run, registers a callback, and returns immediately.
 * The callback will be invoked when the run completes.
 */
export async function runAgentForTelegram(
  params: RunAgentParams,
): Promise<RunAgentResult> {
  const {
    composeId,
    agentName,
    sessionId,
    prompt,
    threadContext,
    userId,
    callbackContext,
  } = params;

  const [compose] = await globalThis.services.db
    .select()
    .from(agentComposes)
    .where(eq(agentComposes.id, composeId))
    .limit(1);

  if (!compose) {
    return {
      status: "failed",
      response: "Error: Agent configuration not found.",
      runId: undefined,
    };
  }

  let versionId = compose.headVersionId;
  if (!versionId) {
    const [latestVersion] = await globalThis.services.db
      .select({ id: agentComposeVersions.id })
      .from(agentComposeVersions)
      .where(eq(agentComposeVersions.composeId, compose.id))
      .orderBy(desc(agentComposeVersions.createdAt))
      .limit(1);

    if (!latestVersion) {
      return {
        status: "failed",
        response: "Error: Agent has no versions configured.",
        runId: undefined,
      };
    }
    versionId = latestVersion.id;
  }

  const fullPrompt = threadContext
    ? `${threadContext}\n\n# User Prompt\n\n${prompt}`
    : prompt;

  const callbackUrl = `${getApiUrl()}/api/internal/callbacks/telegram`;
  const callbackSecret = generateCallbackSecret();

  try {
    const result = await createRun({
      userId,
      agentComposeVersionId: versionId,
      prompt: fullPrompt,
      composeId: compose.id,
      sessionId,
      agentName,
      artifactName: "artifact",
      memoryName: "memory",
      callbacks: [
        {
          url: callbackUrl,
          secret: callbackSecret,
          payload: callbackContext,
        },
      ],
    });

    log.debug(`Run ${result.runId} dispatched for Telegram agent ${agentName}`);

    return {
      status: "dispatched",
      runId: result.runId,
    };
  } catch (error) {
    if (isConcurrentRunLimit(error)) {
      return {
        status: "failed",
        response:
          "You have too many concurrent runs. Please wait for existing runs to complete.",
        runId: undefined,
      };
    }
    throw error;
  }
}
