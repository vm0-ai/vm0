import { isRunDispatchError } from "../../../infra/run";
import { createZeroRun } from "../../zero-run-service";
import { buildTelegramPrompt } from "../../integration-prompt";
import { isApiError } from "../../../shared/errors";
import { RUN_ERROR_GUIDANCE } from "@vm0/core";
import { logger } from "../../../shared/logger";
import { generateCallbackSecret, getApiUrl } from "../../../infra/callback";
import type { TelegramCallbackPayload } from "../../../infra/callback/callback-payloads";

const log = logger("telegram:run-agent");

interface RunAgentParams {
  composeId: string;
  agentId: string;
  agentName: string;
  sessionId: string | undefined;
  prompt: string;
  threadContext: string;
  userId: string;
  callbackContext: TelegramCallbackPayload;
}

interface RunAgentResult {
  status: "accepted" | "queued" | "failed";
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
    agentId,
    agentName,
    sessionId,
    prompt,
    threadContext,
    userId,
    callbackContext,
  } = params;

  const appendSystemPrompt = buildTelegramPrompt(threadContext) || undefined;

  const callbackUrl = `${getApiUrl()}/api/internal/callbacks/telegram`;
  const callbackSecret = generateCallbackSecret();

  try {
    const result = await createZeroRun({
      userId,
      agentId,
      prompt,
      appendSystemPrompt,
      sessionId,
      triggerSource: "telegram",
      callbacks: [
        {
          url: callbackUrl,
          secret: callbackSecret,
          payload: callbackContext,
        },
      ],
    });

    const status = result.status === "queued" ? "queued" : "accepted";
    log.debug(`Run ${result.runId} ${status} for Telegram agent ${agentName}`);

    return {
      status,
      runId: result.runId,
    };
  } catch (error) {
    if (isApiError(error)) {
      const guidance = RUN_ERROR_GUIDANCE[error.code];
      const response = guidance
        ? `${guidance.title}: ${guidance.guidance}`
        : error.message;
      log.warn(`Pre-run check failed: ${error.code}`, {
        composeId,
        agentName,
        userId,
      });
      return { status: "failed", response, runId: undefined };
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
