import { eq, desc } from "drizzle-orm";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../db/schema/agent-compose";
import { agentRuns } from "../../../db/schema/agent-run";
import { decryptCredentialValue } from "../../crypto/secrets-encryption";
import { generateSandboxToken } from "../../auth/sandbox-token";
import { buildExecutionContext, prepareAndDispatchRun } from "../../run";
import { queryAxiom, getDatasetName, DATASETS } from "../../axiom";
import { logger } from "../../logger";

const log = logger("slack:run-agent");

interface RunAgentParams {
  binding: {
    id: string;
    composeId: string;
    encryptedSecrets: string | null;
  };
  sessionId: string | undefined;
  prompt: string;
  threadContext: string;
  userId: string;
  encryptionKey: string;
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

/**
 * Execute an agent run for Slack
 *
 * This creates a run, waits for completion, and returns the response
 */
export async function runAgentForSlack(
  params: RunAgentParams,
): Promise<string> {
  const { binding, sessionId, prompt, threadContext, userId, encryptionKey } =
    params;

  try {
    // Get compose and latest version
    const [compose] = await globalThis.services.db
      .select()
      .from(agentComposes)
      .where(eq(agentComposes.id, binding.composeId))
      .limit(1);

    if (!compose) {
      return "Error: Agent configuration not found.";
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
        return "Error: Agent has no versions configured.";
      }
      versionId = latestVersion.id;
    }

    // Decrypt binding secrets if present
    let secrets: Record<string, string> = {};
    if (binding.encryptedSecrets) {
      const decrypted = decryptCredentialValue(
        binding.encryptedSecrets,
        encryptionKey,
      );
      secrets = parseSecrets(decrypted);
    }

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
      return "Error: Failed to create run.";
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
      timeoutMs: 5 * 60 * 1000, // 5 minute timeout
      pollIntervalMs: 1000,
    });

    if (result.status === "completed") {
      return result.output ?? "Task completed successfully.";
    } else if (result.status === "failed") {
      return `Error: ${result.error ?? "Agent execution failed."}`;
    } else {
      return "The agent is still working on your request. Check back later.";
    }
  } catch (error) {
    log.error("Error running agent for Slack:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return `Error executing agent: ${message}`;
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
 * Parse secrets from KEY=value format
 */
function parseSecrets(secretsStr: string): Record<string, string> {
  const secrets: Record<string, string> = {};
  const lines = secretsStr.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex > 0) {
      const key = trimmed.substring(0, eqIndex).trim();
      const value = trimmed.substring(eqIndex + 1).trim();
      secrets[key] = value;
    }
  }

  return secrets;
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
