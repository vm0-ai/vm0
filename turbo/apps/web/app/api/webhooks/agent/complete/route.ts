import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../src/lib/ts-rest-handler";
import { webhookCompleteContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { checkpoints } from "../../../../../src/db/schema/checkpoint";
import { agentSessions } from "../../../../../src/db/schema/agent-session";
import { eq, and } from "drizzle-orm";
import {
  transitionRunStatus,
  dispatchTerminalSideEffects,
} from "../../../../../src/lib/run/run-status";
import { getSandboxAuthForRun } from "../../../../../src/lib/auth/get-sandbox-auth";
import type {
  ArtifactSnapshot,
  MemorySnapshot,
} from "../../../../../src/lib/checkpoint";
import type { RunResult } from "../../../../../src/lib/run/types";
import { logger } from "../../../../../src/lib/logger";
import { drainOrgQueue } from "../../../../../src/lib/run/run-queue-service";
import { dispatchQueuedRun } from "../../../../../src/lib/run/run-service";
import { processOrgCredits } from "../../../../../src/lib/credit/credit-service";
import { appendChatMessages } from "../../../../../src/lib/agent-session/agent-session-service";
import { extractRunOutput } from "../../../../../src/lib/run/extract-run-output";
import {
  queryAxiom,
  getDatasetName,
  DATASETS,
} from "../../../../../src/lib/axiom";
import { after } from "next/server";

const log = logger("webhook:complete");

interface AxiomEventContent {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

function extractSummariesFromEvents(
  events: Array<{
    eventData: { message?: { content?: AxiomEventContent[] } };
  }>,
): string[] {
  let lastTextIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!event) {
      continue;
    }
    const content = event.eventData?.message?.content ?? [];
    if (content.some((b) => b.type === "text" && b.text)) {
      lastTextIdx = i;
      break;
    }
  }

  const summaries: string[] = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (!event) {
      continue;
    }
    const content = event.eventData?.message?.content ?? [];
    for (const block of content) {
      if (block.type === "tool_use" && block.name) {
        summaries.push(block.name);
        break;
      }
      if (i !== lastTextIdx && block.type === "text" && block.text) {
        const line = block.text.split("\n")[0] ?? "";
        summaries.push(line.length > 80 ? line.slice(0, 80) + "…" : line);
        break;
      }
    }
  }
  return summaries;
}

async function extractSummariesFromAxiom(runId: string): Promise<string[]> {
  const dataset = getDatasetName(DATASETS.AGENT_RUN_EVENTS);
  const apl = `['${dataset}']
| where runId == "${runId}"
| where eventType == "message"
| order by sequenceNumber asc
| limit 200`;

  const events = await queryAxiom<{
    eventData: { message?: { content?: AxiomEventContent[] } };
  }>(apl);

  return extractSummariesFromEvents(events);
}

/**
 * Persist user prompt and assistant result as chat messages on the session.
 * Runs in after() — best-effort, errors are logged but not propagated.
 */
async function persistChatMessages(
  runId: string,
  sessionId: string,
  userId: string,
  prompt: string,
): Promise<void> {
  const [output, summaries] = await Promise.all([
    extractRunOutput(runId),
    extractSummariesFromAxiom(runId),
  ]);

  const messages: Array<{
    role: "user" | "assistant";
    content: string;
    runId?: string;
    summaries?: string[];
  }> = [{ role: "user", content: prompt }];

  if (output.result) {
    messages.push({
      role: "assistant",
      content: output.result,
      runId,
      ...(summaries.length > 0 ? { summaries } : {}),
    });
  }

  await appendChatMessages(sessionId, userId, messages);
  log.debug(`Persisted ${messages.length} chat messages for run ${runId}`);
}

/**
 * Schedule terminal side effects in a non-blocking after() block.
 */
function scheduleTerminalSideEffects(
  runId: string,
  status: "completed" | "failed",
  orgId: string,
  errorMsg?: string,
): void {
  after(async () => {
    await dispatchTerminalSideEffects(runId, status, errorMsg, () =>
      drainOrgQueue(orgId, dispatchQueuedRun),
    );
    await processOrgCredits(orgId);
  });
}

/**
 * Build a RunResult from a checkpoint record.
 */
function buildRunResult(
  checkpoint: typeof checkpoints.$inferSelect,
  sessionId: string | undefined,
): RunResult {
  const artifactSnapshot =
    checkpoint.artifactSnapshot as ArtifactSnapshot | null;
  const memorySnapshot = checkpoint.memorySnapshot as MemorySnapshot | null;
  const volumeVersions = checkpoint.volumeVersionsSnapshot as
    | { versions: Record<string, string> }
    | undefined;

  const result: RunResult = {
    checkpointId: checkpoint.id,
    agentSessionId: sessionId ?? checkpoint.conversationId,
    conversationId: checkpoint.conversationId,
    volumes: volumeVersions?.versions,
  };

  if (artifactSnapshot) {
    result.artifact = {
      [artifactSnapshot.artifactName]: artifactSnapshot.artifactVersion,
    };
  }

  if (memorySnapshot) {
    result.memory = {
      [memorySnapshot.memoryName]: memorySnapshot.memoryVersion,
    };
  }

  return result;
}

const router = tsr.router(webhookCompleteContract, {
  complete: async ({ body, headers }) => {
    initServices();

    // Authenticate with sandbox JWT and verify runId matches
    const auth = getSandboxAuthForRun(body.runId, headers.authorization);
    if (!auth) {
      return {
        status: 401 as const,
        body: {
          error: {
            message: "Not authenticated or runId mismatch",
            code: "UNAUTHORIZED",
          },
        },
      };
    }

    const { userId } = auth;

    log.debug(
      `Received completion for run ${body.runId}, exitCode=${body.exitCode}`,
    );

    // Get run record
    const [run] = await globalThis.services.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.id, body.runId), eq(agentRuns.userId, userId)))
      .limit(1);

    if (!run) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent run not found", code: "NOT_FOUND" },
        },
      };
    }

    // Idempotency check: if run is already completed/failed, return early
    if (run.status === "completed" || run.status === "failed") {
      log.debug(
        `Run ${body.runId} already ${run.status}, skipping duplicate completion`,
      );
      return {
        status: 200 as const,
        body: {
          success: true,
          status: run.status as "completed" | "failed",
        },
      };
    }

    let finalStatus: "completed" | "failed";

    if (body.exitCode === 0) {
      // Success: query checkpoint and store result in run table
      const [checkpoint] = await globalThis.services.db
        .select()
        .from(checkpoints)
        .where(eq(checkpoints.runId, body.runId))
        .limit(1);

      if (!checkpoint) {
        const transitioned = await transitionRunStatus(
          body.runId,
          {
            status: "failed",
            completedAt: new Date(),
            error: "Checkpoint for run not found",
          },
          ["pending", "running"],
        );

        // Dispatch callbacks so the user gets notified about the failure
        // (previously this path returned without dispatching)
        if (transitioned) {
          scheduleTerminalSideEffects(
            body.runId,
            "failed",
            run.orgId,
            "Checkpoint for run not found",
          );
        }

        return {
          status: 404 as const,
          body: {
            error: {
              message: "Checkpoint for run not found",
              code: "NOT_FOUND",
            },
          },
        };
      }

      // Get agent session for the conversation
      const [session] = await globalThis.services.db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.conversationId, checkpoint.conversationId))
        .limit(1);

      const result = buildRunResult(checkpoint, session?.id);

      // Atomically transition to "completed" only if still pending/running
      const transitioned = await transitionRunStatus(
        body.runId,
        {
          status: "completed",
          completedAt: new Date(),
          result,
        },
        ["pending", "running"],
      );

      if (!transitioned) {
        log.debug(
          `Run ${body.runId} already transitioned, skipping duplicate completion`,
        );
        return {
          status: 200 as const,
          body: { success: true, status: "completed" as const },
        };
      }

      finalStatus = "completed";
      log.debug(`Run ${body.runId} completed successfully`);

      // Persist chat messages to session (non-blocking)
      if (session) {
        after(async () => {
          await persistChatMessages(
            body.runId,
            session.id,
            userId,
            run.prompt,
          ).catch((err) =>
            log.error("Failed to persist chat messages", { err }),
          );
        });
      }
    } else {
      // Failure: store error in run table
      const errorMessage =
        body.error || `Agent exited with code ${body.exitCode}`;

      const transitioned = await transitionRunStatus(
        body.runId,
        {
          status: "failed",
          completedAt: new Date(),
          error: errorMessage,
        },
        ["pending", "running"],
      );

      if (!transitioned) {
        log.debug(
          `Run ${body.runId} already transitioned, skipping duplicate failure`,
        );
        return {
          status: 200 as const,
          body: { success: true, status: "failed" as const },
        };
      }

      finalStatus = "failed";
      log.warn(`Run ${body.runId} failed: ${errorMessage}`);
    }

    // Dispatch all registered callbacks and drain run queue (non-blocking)
    const errorMsg =
      finalStatus === "failed"
        ? (body.error ?? `Agent exited with code ${body.exitCode}`)
        : undefined;
    scheduleTerminalSideEffects(body.runId, finalStatus, run.orgId, errorMsg);

    return {
      status: 200 as const,
      body: {
        success: true,
        status: finalStatus,
      },
    };
  },
});

/**
 * Custom error handler to convert Zod validation errors to API error format
 */
function errorHandler(err: unknown): TsRestResponse | void {
  if (err && typeof err === "object" && "bodyError" in err) {
    const validationError = err as {
      bodyError: { issues: Array<{ path: string[]; message: string }> } | null;
    };

    if (validationError.bodyError) {
      const issue = validationError.bodyError.issues[0];
      if (issue) {
        const path = issue.path.join(".");
        const message = path ? `${path}: ${issue.message}` : issue.message;
        return TsRestResponse.fromJson(
          { error: { message, code: "BAD_REQUEST" } },
          { status: 400 },
        );
      }
    }
  }

  return undefined;
}

const handler = createHandler(webhookCompleteContract, router, {
  errorHandler,
});

export { handler as POST };
