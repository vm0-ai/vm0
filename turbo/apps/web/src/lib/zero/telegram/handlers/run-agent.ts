import { isRunDispatchError } from "../../../infra/run";
import { createZeroRun } from "../../zero-run-service";
import { isApiError } from "../../../shared/errors";
import { RUN_ERROR_GUIDANCE } from "@vm0/core/contracts/errors";
import { logger } from "../../../shared/logger";
import type { TelegramCallbackPayload } from "../../../infra/callback/callback-payloads";
import { adaptTelegramTrigger } from "./adapt-telegram-trigger";

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
  apiStartTime: number;
}

interface RunAgentResult {
  status: "accepted" | "queued" | "failed";
  response?: string;
  runId: string | undefined;
}

/**
 * Execute an agent run for Telegram.
 *
 * Thin orchestrator: adapt Telegram-specific params into CreateZeroRunParams,
 * call createZeroRun (which defers dispatch internally), translate errors
 * into Telegram-user-facing strings.
 */
export async function runAgentForTelegram(
  params: RunAgentParams,
): Promise<RunAgentResult> {
  try {
    const result = await createZeroRun(adaptTelegramTrigger(params));
    const status: "accepted" | "queued" =
      result.status === "queued" ? "queued" : "accepted";
    log.debug(
      `Run ${result.runId} ${status} for Telegram agent ${params.agentName}`,
    );
    return { status, runId: result.runId };
  } catch (error) {
    return translateTelegramRunError(error, params);
  }
}

function translateTelegramRunError(
  error: unknown,
  params: RunAgentParams,
): RunAgentResult {
  const { composeId, agentName, userId } = params;
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
