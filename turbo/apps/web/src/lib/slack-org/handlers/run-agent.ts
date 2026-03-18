import { startRun, isRunDispatchError } from "../../run";
import { buildIntegrationContext } from "../../integration-context";
import { generateCallbackSecret, getApiUrl } from "../../callback";
import { logger } from "../../logger";

const log = logger("slack-org:run-agent");

/**
 * Org-aware callback context for Slack.
 * orgId is derived from composeId -> agentComposes.orgId at dispatch time.
 */
export interface SlackOrgCallbackContext {
  workspaceId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  connectionId: string;
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
  callbackContext: SlackOrgCallbackContext;
}

interface RunAgentResult {
  status: "dispatched" | "queued" | "failed";
  response?: string;
  runId: string | undefined;
}

/**
 * Execute an agent run for org-aware Slack integration.
 *
 * Uses the unified startRun() entry point which handles compose/org resolution.
 * This function only handles Slack-specific concerns: prompt construction and callbacks.
 */
export async function runAgentForSlackOrg(
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
    // Build prompt with integration context (Slack-specific)
    const integrationContext = buildIntegrationContext("Slack");
    const fullPrompt = threadContext
      ? `${integrationContext}\n\n${threadContext}\n\n# User Prompt\n\n${prompt}`
      : `${integrationContext}\n\n# User Prompt\n\n${prompt}`;

    // Build callback (Slack-specific)
    const callbackUrl = `${getApiUrl()}/api/internal/callbacks/slack/org`;
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
    log.debug(`Run ${result.runId} ${status} for Slack org agent ${agentName}`);

    return { status, runId: result.runId };
  } catch (error) {
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
