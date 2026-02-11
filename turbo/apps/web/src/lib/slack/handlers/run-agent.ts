import { eq, desc } from "drizzle-orm";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../db/schema/agent-compose";
import { agentRuns } from "../../../db/schema/agent-run";
import { agentRunCallbacks } from "../../../db/schema/agent-run-callback";
import { generateSandboxToken } from "../../auth/sandbox-token";
import { buildExecutionContext, prepareAndDispatchRun } from "../../run";
import { queryAxiom, getDatasetName, DATASETS } from "../../axiom";
import { logger } from "../../logger";
import { getUserScopeByClerkId } from "../../scope/scope-service";
import { getSecretValues } from "../../secret/secret-service";
import { encryptCredentialValue } from "../../crypto/secrets-encryption";
import { generateCallbackSecret, getApiUrl } from "../../callback";
import { env } from "../../../env";

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
  reactionAdded: boolean;
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
  status: "dispatched" | "failed";
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
  const { SECRETS_ENCRYPTION_KEY } = env();

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

    // Load secrets from user's scope
    const scope = await getUserScopeByClerkId(userId);
    const secrets: Record<string, string> = scope
      ? await getSecretValues(scope.id)
      : {};

    // Build the full prompt with thread context
    const fullPrompt = threadContext
      ? `${threadContext}\n\n# User Prompt\n\n${prompt}`
      : prompt;

    // Create run record in database
    const [run] = await globalThis.services.db
      .insert(agentRuns)
      .values({
        userId,
        agentComposeVersionId: versionId,
        status: "pending",
        prompt: fullPrompt,
        secretNames:
          Object.keys(secrets).length > 0 ? Object.keys(secrets) : null,
        lastHeartbeatAt: new Date(),
      })
      .returning();

    if (!run) {
      return {
        status: "failed",
        response: "Error: Failed to create run.",
        runId: undefined,
      };
    }

    log.debug(`Created run ${run.id} for Slack agent ${agentName}`);

    // Register callback for run completion
    const callbackSecret = generateCallbackSecret();
    const encryptedSecret = encryptCredentialValue(
      callbackSecret,
      SECRETS_ENCRYPTION_KEY,
    );
    const callbackUrl = `${getApiUrl()}/api/internal/callbacks/slack`;

    await globalThis.services.db.insert(agentRunCallbacks).values({
      runId: run.id,
      url: callbackUrl,
      encryptedSecret,
      payload: callbackContext,
    });

    log.debug(`Registered callback for run ${run.id}`);

    // Generate sandbox token
    const sandboxToken = await generateSandboxToken(userId, run.id);

    // Build execution context
    const context = await buildExecutionContext({
      sessionId,
      agentComposeVersionId: versionId,
      prompt: fullPrompt,
      secrets,
      runId: run.id,
      sandboxToken,
      userId,
      agentName,
      artifactName: "artifact", // Same default as cook command
    });

    // Dispatch run to executor
    const dispatchResult = await prepareAndDispatchRun(context);
    log.debug(`Run ${run.id} dispatched with status: ${dispatchResult.status}`);

    // Return immediately - callback will handle the response
    return {
      status: "dispatched",
      runId: run.id,
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

/**
 * Query Axiom for the result event to get the agent's output text
 */
export async function getRunOutput(runId: string): Promise<string | undefined> {
  const dataset = getDatasetName(DATASETS.AGENT_RUN_EVENTS);
  const apl = `['${dataset}']
| where runId == "${runId}"
| where eventType == "result"
| order by sequenceNumber desc
| limit 1`;

  interface PermissionDenial {
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
  const result = event?.eventData?.result;
  const denials = event?.eventData?.permission_denials;

  // When AskUserQuestion was denied (sandbox/non-interactive mode),
  // format the questions as readable text so the Slack user can see
  // what the agent wanted to ask.
  const askDenials = denials?.filter((d) => d.tool_name === "AskUserQuestion");
  if (askDenials && askDenials.length > 0) {
    const formatted = formatAskUserDenials(askDenials);
    if (formatted) {
      return result ? `${result}\n\n${formatted}` : formatted;
    }
  }

  return result;
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
