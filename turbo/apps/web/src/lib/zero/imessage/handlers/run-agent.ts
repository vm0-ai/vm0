import { isRunDispatchError } from "../../../infra/run";
import { createZeroRun } from "../../zero-run-service";
import { isApiError } from "@vm0/api-services/errors";
import { RUN_ERROR_GUIDANCE } from "@vm0/api-contracts/contracts/errors";
import { logger } from "../../../shared/logger";
import type { IMessageCallbackPayload } from "../../../infra/callback/callback-payloads";
import type { UserInfoOptions } from "../../integration-prompt";
import { adaptIMessageTrigger } from "./adapt-imessage-trigger";

const log = logger("imessage:run-agent");

interface RunAgentParams {
  agentId: string;
  agentName: string;
  sessionId: string | undefined;
  prompt: string;
  threadContext: string;
  userInfoExtras?: UserInfoOptions;
  phoneHandle: string;
  conversationId: string | null;
  messageId: string;
  userId: string;
  callbackContext: IMessageCallbackPayload;
  apiStartTime: number;
}

interface RunAgentResult {
  status: "accepted" | "queued" | "failed";
  response?: string;
  runId: string | undefined;
}

export async function runAgentForIMessage(
  params: RunAgentParams,
): Promise<RunAgentResult> {
  try {
    const result = await createZeroRun(adaptIMessageTrigger(params));
    const status = result.status === "queued" ? "queued" : "accepted";
    log.debug(`Run ${result.runId} ${status} for iMessage`, {
      agentName: params.agentName,
    });
    return { status, runId: result.runId };
  } catch (error) {
    return translateIMessageRunError(error, params);
  }
}

function translateIMessageRunError(
  error: unknown,
  params: RunAgentParams,
): RunAgentResult {
  if (isApiError(error)) {
    const guidance = RUN_ERROR_GUIDANCE[error.code];
    const response = guidance
      ? `${guidance.title}: ${guidance.guidance}`
      : error.message;
    log.warn(`Pre-run check failed: ${error.code}`, {
      agentName: params.agentName,
      userId: params.userId,
    });
    return { status: "failed", response, runId: undefined };
  }

  const runId = isRunDispatchError(error) ? error.runId : undefined;
  log.error("Failed to create iMessage run", {
    agentName: params.agentName,
    userId: params.userId,
    error,
  });
  return {
    status: "failed",
    response:
      "Something went wrong while starting the agent. Please try again later.",
    runId,
  };
}
