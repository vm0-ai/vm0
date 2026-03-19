import { startRun, isRunDispatchError } from "../../run";
import { buildIntegrationContext } from "../../integration-context";
import { isConcurrentRunLimit } from "../../errors";
import { logger } from "../../logger";
import { generateCallbackSecret, getApiUrl } from "../../callback";

const log = logger("telegram:run-agent");

/**
 * Telegram-specific context to include in the callback payload
 */
interface TelegramCallbackContext {
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
  status: "dispatched" | "queued" | "failed";
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

  const integrationContext = buildIntegrationContext("Telegram");
  const fullPrompt = threadContext
    ? `${integrationContext}\n\n${threadContext}\n\n# User Prompt\n\n${prompt}`
    : `${integrationContext}\n\n# User Prompt\n\n${prompt}`;

  const callbackUrl = `${getApiUrl()}/api/internal/callbacks/telegram`;
  const callbackSecret = generateCallbackSecret();

  try {
    const result = await startRun({
      userId,
      composeId,
      prompt: fullPrompt,
      sessionId,
      callbacks: [
        {
          url: callbackUrl,
          secret: callbackSecret,
          payload: callbackContext,
        },
      ],
    });

    const status = result.status === "queued" ? "queued" : "dispatched";
    log.debug(`Run ${result.runId} ${status} for Telegram agent ${agentName}`);

    return {
      status,
      runId: result.runId,
    };
  } catch (error) {
    if (isConcurrentRunLimit(error)) {
      log.warn("Concurrent run limit reached", {
        composeId,
        agentName,
        userId,
      });
      return {
        status: "failed",
        response:
          "You have too many concurrent runs. Please wait for existing runs to complete.",
        runId: undefined,
      };
    }
    const runId = isRunDispatchError(error) ? error.runId : undefined;
    log.error("Failed to create run", { composeId, agentName, userId, error });
    return {
      status: "failed",
      response:
        "Something went wrong while starting the agent. Please try again later.",
      runId,
    };
  }
}
