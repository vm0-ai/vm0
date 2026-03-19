import { startRun, isRunDispatchError } from "../../run";
import { buildIntegrationContext } from "../../integration-context";
import { logger } from "../../logger";
import { generateCallbackSecret, getApiUrl } from "../../callback";

const log = logger("slack:run-agent");

/**
 * Slack-specific context to include in the callback payload
 */
export interface SlackCallbackContext {
  workspaceId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  userLinkId: string;
  agentName: string;
  composeId: string;
  existingSessionId?: string;
}

interface RunAgentParams {
  composeId: string;
  agentName: string;
  sessionId: string | undefined;
  prompt: string;
  threadContext: string;
  userId: string;
  callbackContext: SlackCallbackContext;
}

interface RunAgentResult {
  status: "dispatched" | "queued" | "failed";
  response?: string;
  runId: string | undefined;
}

/**
 * Execute an agent run for Slack
 *
 * This creates a run, registers a callback, and returns immediately.
 * The callback will be invoked when the run completes.
 */
export async function runAgentForSlack(
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

  try {
    // Build the full prompt with integration context and thread context
    const integrationContext = buildIntegrationContext("Slack");
    const fullPrompt = threadContext
      ? `${integrationContext}\n\n${threadContext}\n\n# User Prompt\n\n${prompt}`
      : `${integrationContext}\n\n# User Prompt\n\n${prompt}`;

    // Build callback for run completion notification
    const callbackUrl = `${getApiUrl()}/api/internal/callbacks/slack`;
    const callbackSecret = generateCallbackSecret();

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
    log.debug(`Run ${result.runId} ${status} for Slack agent ${agentName}`);

    return {
      status,
      runId: result.runId,
    };
  } catch (error) {
    const runId = isRunDispatchError(error) ? error.runId : undefined;
    log.error("Error running agent for Slack:", error);
    return {
      status: "failed",
      response:
        "Something went wrong while starting the agent. Please try again later.",
      runId,
    };
  }
}
