import { eq, desc } from "drizzle-orm";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../db/schema/agent-compose";
import { createRun } from "../../run";
import { queryAxiom, getDatasetName, DATASETS } from "../../axiom";
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
    // Get compose and latest version
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

    // Get latest version (using headVersionId if available, otherwise query)
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

    // Build the full prompt with integration context and thread context
    const integrationContext =
      "# Current Integration\nYou are currently running inside: Slack";
    const fullPrompt = threadContext
      ? `${integrationContext}\n\n${threadContext}\n\n# User Prompt\n\n${prompt}`
      : `${integrationContext}\n\n# User Prompt\n\n${prompt}`;

    // Build callback for run completion notification
    const callbackUrl = `${getApiUrl()}/api/internal/callbacks/slack`;
    const callbackSecret = generateCallbackSecret();

    // Delegate all orchestration to createRun()
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

    const status = result.status === "queued" ? "queued" : "dispatched";
    log.debug(`Run ${result.runId} ${status} for Slack agent ${agentName}`);

    return {
      status,
      runId: result.runId,
    };
  } catch (error) {
    log.error("Error running agent for Slack:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      status: "failed",
      response: `Error executing agent: ${message}`,
      runId: undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Axiom result querying
// ---------------------------------------------------------------------------

export interface PermissionDenial {
  tool_name: string;
  tool_input?: {
    questions?: Array<{
      question: string;
      header?: string;
      options?: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }>;
  };
}

interface RunResultData {
  result?: string;
  askUserDenials: PermissionDenial[];
}

/**
 * Query Axiom for the result event data (text output + permission denials).
 * Shared by getRunOutput (text formatting) and the callback handler (raw denials).
 */
export async function getRunResultData(
  runId: string,
): Promise<RunResultData | undefined> {
  const dataset = getDatasetName(DATASETS.AGENT_RUN_EVENTS);
  const apl = `['${dataset}']
| where runId == "${runId}"
| where eventType == "result"
| order by sequenceNumber desc
| limit 1`;

  interface ResultEvent {
    eventData: {
      result?: string;
      permission_denials?: PermissionDenial[];
    };
  }

  const events = await queryAxiom<ResultEvent>(apl);
  if (!events || events.length === 0) {
    return undefined;
  }

  const event = events[0];
  const denials = event?.eventData?.permission_denials ?? [];
  const askUserDenials = denials.filter(
    (d) => d.tool_name === "AskUserQuestion",
  );

  return {
    result: event?.eventData?.result,
    askUserDenials,
  };
}

/**
 * Query Axiom for the result event to get the agent's output text.
 * Formats AskUserQuestion denials as plain text (fallback for non-interactive contexts).
 */
export async function getRunOutput(runId: string): Promise<string | undefined> {
  const data = await getRunResultData(runId);
  if (!data) {
    return undefined;
  }

  if (data.askUserDenials.length > 0) {
    const formatted = formatAskUserDenials(data.askUserDenials);
    if (formatted) {
      return data.result ? `${data.result}\n\n${formatted}` : formatted;
    }
  }

  return data.result;
}

export function formatAskUserDenials(
  denials: Array<{
    tool_input?: {
      questions?: Array<{
        question: string;
        header?: string;
        options?: Array<{ label: string; description?: string }>;
        multiSelect?: boolean;
      }>;
    };
  }>,
): string | undefined {
  const parts: string[] = [];

  for (const denial of denials) {
    const questions = denial.tool_input?.questions;
    if (!questions || questions.length === 0) continue;

    for (const q of questions) {
      parts.push(q.question);
      if (q.options) {
        for (const opt of q.options) {
          const desc = opt.description ? ` — ${opt.description}` : "";
          parts.push(`  • ${opt.label}${desc}`);
        }
      }
    }
  }

  if (parts.length === 0) return undefined;

  return `The agent needs your input to proceed:\n\n${parts.join("\n")}`;
}
