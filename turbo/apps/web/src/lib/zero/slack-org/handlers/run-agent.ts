import { RUN_ERROR_GUIDANCE } from "@vm0/api-contracts/contracts/errors";
import { isRunDispatchError } from "../../../infra/run";
import type { SlackOrgCallbackPayload } from "../../../infra/callback/callback-payloads";
import { isApiError } from "@vm0/api-services/errors";
import { logger } from "../../../shared/logger";
import type { UserInfoOptions } from "../../integration-prompt";
import { createZeroRun } from "../../zero-run-service";
import { adaptSlackTrigger } from "./adapt-slack-trigger";

const log = logger("slack-org:run-agent");

interface RunAgentParams {
  composeId: string;
  agentId: string;
  agentName: string;
  orgId: string;
  sessionId: string | undefined;
  prompt: string;
  threadContext: string;
  userInfoExtras?: UserInfoOptions;
  userId: string;
  modelProviderId: string | null;
  selectedModel: string | null;
  botUserId: string;
  channelId?: string;
  channelType?: "channel" | "dm" | "group_dm";
  threadTs?: string;
  callbackContext: SlackOrgCallbackPayload;
  apiStartTime: number;
}

interface RunAgentResult {
  status: "accepted" | "queued" | "failed";
  response?: string;
  runId: string | undefined;
  errorCode?: string;
}

interface LogContext {
  composeId: string;
  agentName: string;
  userId: string;
}

/**
 * Execute an agent run for org-aware Slack integration.
 *
 * The adapter (adaptSlackTrigger) owns the pure Slack-trigger → createZeroRun
 * params transform. This orchestrator handles createZeroRun invocation,
 * status mapping, and Slack-specific error translation.
 */
export async function runAgentForSlackOrg(
  params: RunAgentParams,
): Promise<RunAgentResult> {
  const { composeId, agentName, userId } = params;
  const logContext: LogContext = { composeId, agentName, userId };

  try {
    const result = await createZeroRun({
      ...adaptSlackTrigger({
        userId: params.userId,
        agentId: params.agentId,
        sessionId: params.sessionId,
        prompt: params.prompt,
        threadContext: params.threadContext,
        userInfoExtras: params.userInfoExtras,
        botUserId: params.botUserId,
        channelId: params.channelId,
        channelType: params.channelType,
        threadTs: params.threadTs,
        callbackContext: params.callbackContext,
        apiStartTime: params.apiStartTime,
      }),
      modelProviderId: params.modelProviderId ?? undefined,
      selectedModelOverride: params.selectedModel ?? undefined,
    });

    const status = result.status === "queued" ? "queued" : "accepted";
    log.debug(`Run ${result.runId} ${status} for Slack org agent ${agentName}`);

    return { status, runId: result.runId };
  } catch (error) {
    return translateSlackRunError(error, logContext);
  }
}

function translateSlackRunError(
  error: unknown,
  logContext: LogContext,
): RunAgentResult {
  if (isApiError(error)) {
    const guidance = RUN_ERROR_GUIDANCE[error.code];
    const response = guidance
      ? `${guidance.title}: ${guidance.guidance}`
      : error.message;
    log.warn(`Pre-run check failed: ${error.code}`, logContext);
    return {
      status: "failed",
      response,
      runId: undefined,
      errorCode: error.code,
    };
  }
  const runId = isRunDispatchError(error) ? error.runId : undefined;
  log.error("Error running agent for Slack org:", error);
  return {
    status: "failed",
    response:
      "Something went wrong while starting the agent. Please try again later.",
    runId,
  };
}
