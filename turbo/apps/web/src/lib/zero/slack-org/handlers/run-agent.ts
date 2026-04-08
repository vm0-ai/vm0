import { isRunDispatchError } from "../../../infra/run";
import { createZeroRun } from "../../zero-run-service";
import { buildIntegrationContext } from "../../integration-context";
import { isApiError } from "../../../shared/errors";
import { RUN_ERROR_GUIDANCE } from "@vm0/core";
import { generateCallbackSecret, getApiUrl } from "../../../infra/callback";
import { logger } from "../../../shared/logger";
import type { SlackOrgCallbackPayload } from "../../../infra/callback/callback-payloads";

const log = logger("slack-org:run-agent");

interface RunAgentParams {
  composeId: string;
  agentId: string;
  agentName: string;
  sessionId: string | undefined;
  prompt: string;
  threadContext: string;
  userContext: string;
  userId: string;
  botUserId: string;
  channelId?: string;
  channelType?: "channel" | "dm" | "group_dm";
  threadTs?: string;
  callbackContext: SlackOrgCallbackPayload;
}

interface RunAgentResult {
  status: "dispatched" | "queued" | "failed";
  response?: string;
  runId: string | undefined;
  errorCode?: string;
}

/**
 * Execute an agent run for org-aware Slack integration.
 *
 * Uses createZeroRun() which handles compose/org resolution.
 * This function only handles Slack-specific concerns: prompt construction and callbacks.
 *
 * Context (integration header, thread history, user metadata) is passed via
 * appendSystemPrompt so Claude sees it as system-level instructions rather than
 * user input. createZeroRun() prepends agent identity to appendSystemPrompt.
 */
export async function runAgentForSlackOrg(
  params: RunAgentParams,
): Promise<RunAgentResult> {
  const {
    composeId,
    agentId,
    agentName,
    sessionId,
    prompt,
    threadContext,
    userContext,
    userId,
    botUserId,
    channelId,
    channelType,
    threadTs,
    callbackContext,
  } = params;

  try {
    // Build system prompt from context parts (agent identity is prepended by createZeroRun)
    const contextParts = [
      buildIntegrationContext("Slack", {
        botUserId,
        channelId,
        channelType,
        threadId: threadTs,
      }),
      threadContext,
      userContext,
    ].filter(Boolean);
    const appendSystemPrompt =
      contextParts.length > 0 ? contextParts.join("\n\n") : undefined;

    // Build callback (Slack-specific)
    const callbackUrl = `${getApiUrl()}/api/internal/callbacks/slack/org`;
    const callbackSecret = generateCallbackSecret();

    const result = await createZeroRun({
      userId,
      agentId,
      prompt,
      appendSystemPrompt,
      sessionId,
      triggerSource: "slack",
      callbacks: [
        {
          url: callbackUrl,
          secret: callbackSecret,
          payload: callbackContext,
        },
      ],
    });

    const status = result.status === "queued" ? "queued" : "dispatched";
    log.debug(`Run ${result.runId} ${status} for Slack org agent ${agentName}`);

    return { status, runId: result.runId };
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
}
