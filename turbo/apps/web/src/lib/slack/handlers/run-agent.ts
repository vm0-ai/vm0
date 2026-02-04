import { eq, desc, and, gte } from "drizzle-orm";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../db/schema/agent-compose";
import { agentRuns } from "../../../db/schema/agent-run";
import { agentSessions } from "../../../db/schema/agent-session";
import { generateSandboxToken } from "../../auth/sandbox-token";
import { buildExecutionContext, prepareAndDispatchRun } from "../../run";
import { queryAxiom, getDatasetName, DATASETS } from "../../axiom";
import { logger } from "../../logger";
import { getUserScopeByClerkId } from "../../scope/scope-service";
import { getSecretValues } from "../../secret/secret-service";

const log = logger("slack:run-agent");

interface RunAgentParams {
  binding: {
    id: string;
    composeId: string;
  };
  sessionId: string | undefined;
  prompt: string;
  threadContext: string;
  userId: string;
}

interface WaitOptions {
  timeoutMs: number;
  pollIntervalMs: number;
}

interface WaitResult {
  status: "completed" | "failed" | "timeout";
  output?: string;
  error?: string;
}

interface RunAgentResult {
  response: string;
  sessionId: string | undefined;
}

/**
 * Execute an agent run for Slack
 *
 * This creates a run, waits for completion, and returns the response
 */
export async function runAgentForSlack(
  params: RunAgentParams,
): Promise<RunAgentResult> {
  const { binding, sessionId, prompt, threadContext, userId } = params;

  try {
    // Get compose and latest version
    const [compose] = await globalThis.services.db
      .select()
      .from(agentComposes)
      .where(eq(agentComposes.id, binding.composeId))
      .limit(1);

    if (!compose) {
      return { response: "Error: Agent configuration not found.", sessionId };
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
          response: "Error: Agent has no versions configured.",
          sessionId,
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
      ? `${threadContext}\n\n---\n\nUser: ${prompt}`
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
      return { response: "Error: Failed to create run.", sessionId };
    }

    log.debug(`Created run ${run.id} for Slack binding ${binding.id}`);

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
      agentName: compose.name,
    });

    // Dispatch run to executor
    const dispatchResult = await prepareAndDispatchRun(context);
    log.debug(`Run ${run.id} dispatched with status: ${dispatchResult.status}`);

    // Wait for run completion
    const result = await waitForRunCompletion(run.id, {
      timeoutMs: 30 * 60 * 1000, // 30 minute timeout
      pollIntervalMs: 5000, // 5 second polling interval
    });

    // If no existing session, find the session created/updated for this run
    // Use updatedAt >= run.createdAt to catch both new and updated sessions
    let resultSessionId = sessionId;
    if (!sessionId && result.status === "completed") {
      const [newSession] = await globalThis.services.db
        .select({ id: agentSessions.id })
        .from(agentSessions)
        .where(
          and(
            eq(agentSessions.userId, userId),
            eq(agentSessions.agentComposeId, binding.composeId),
            gte(agentSessions.updatedAt, run.createdAt),
          ),
        )
        .orderBy(desc(agentSessions.updatedAt))
        .limit(1);

      resultSessionId = newSession?.id;
    }

    if (result.status === "completed") {
      return {
        response: result.output ?? "Task completed successfully.",
        sessionId: resultSessionId,
      };
    } else if (result.status === "failed") {
      return {
        response: `Error: ${result.error ?? "Agent execution failed."}`,
        sessionId: resultSessionId,
      };
    } else {
      return {
        response:
          "The agent is still working on your request. Check back later.",
        sessionId: resultSessionId,
      };
    }
  } catch (error) {
    log.error("Error running agent for Slack:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return { response: `Error executing agent: ${message}`, sessionId };
  }
}

/**
 * Wait for a run to complete by polling the database
 * Also queries Axiom for the result event to get the output text
 */
async function waitForRunCompletion(
  runId: string,
  options: WaitOptions,
): Promise<WaitResult> {
  const { timeoutMs, pollIntervalMs } = options;
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    // Query run status from database
    const [run] = await globalThis.services.db
      .select({
        status: agentRuns.status,
        error: agentRuns.error,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);

    if (!run) {
      return { status: "failed", error: "Run not found" };
    }

    if (run.status === "completed") {
      // Query Axiom for the result event to get output text
      const output = await getRunOutput(runId);
      return { status: "completed", output };
    }

    if (run.status === "failed") {
      return { status: "failed", error: run.error ?? "Unknown error" };
    }

    // Wait before polling again
    await sleep(pollIntervalMs);
  }

  return { status: "timeout" };
}

/**
 * Query Axiom for the result event to get the agent's output text
 */
async function getRunOutput(runId: string): Promise<string | undefined> {
  const dataset = getDatasetName(DATASETS.AGENT_RUN_EVENTS);
  const apl = `['${dataset}']
| where runId == "${runId}"
| where eventType == "result"
| order by sequenceNumber desc
| limit 1`;

  interface ResultEvent {
    eventData: {
      result?: string;
    };
  }

  const events = await queryAxiom<ResultEvent>(apl);
  if (!events || events.length === 0) {
    return undefined;
  }

  return events[0]?.eventData?.result;
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
