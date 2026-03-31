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
import { dispatchQueuedZeroRun } from "../../../../../src/lib/zero/zero-queue-service";
import { processOrgCredits } from "../../../../../src/lib/credit/credit-service";
import { appendChatMessages } from "../../../../../src/lib/agent-session/agent-session-service";
import { chatThreadRuns } from "../../../../../src/db/schema/chat-thread";
import { updateChatThreadTitle } from "../../../../../src/lib/chat-thread";
import { generateChatTitle } from "../../../../../src/lib/ai/lightweight-model";
import {
  queryAxiom,
  getDatasetName,
  DATASETS,
} from "../../../../../src/lib/axiom";
import { after } from "next/server";
import type { SummaryEntry } from "@vm0/core";

const log = logger("webhook:complete");

interface AxiomEventContent {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

function summarizeContentBlock(
  block: AxiomEventContent,
  skipText: boolean,
): SummaryEntry | null {
  if (block.type === "tool_use" && block.name) {
    return {
      kind: "tool",
      name: block.name,
      ...(block.input ? { input: block.input } : {}),
    };
  }
  if (!skipText && block.type === "text" && block.text) {
    const line = block.text.split("\n")[0] ?? "";
    return {
      kind: "text",
      text: line.length > 80 ? line.slice(0, 80) + "…" : line,
    };
  }
  return null;
}

function findLastTextEventIndex(
  events: Array<{ eventData: { message?: { content?: AxiomEventContent[] } } }>,
): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const content = events[i]?.eventData?.message?.content ?? [];
    if (content.some((b) => b.type === "text" && b.text)) {
      return i;
    }
  }
  return -1;
}

function extractSummariesFromEvents(
  events: Array<{
    eventData: { message?: { content?: AxiomEventContent[] } };
  }>,
): SummaryEntry[] {
  const lastTextIdx = findLastTextEventIndex(events);
  const summaries: SummaryEntry[] = [];

  for (let i = 0; i < events.length; i++) {
    const content = events[i]?.eventData?.message?.content ?? [];
    for (const block of content) {
      const entry = summarizeContentBlock(block, i === lastTextIdx);
      if (entry) {
        summaries.push(entry);
        break;
      }
    }
  }
  return summaries;
}

interface CombinedRunEvent {
  eventType: string;
  eventData: {
    result?: string;
    message?: { content?: AxiomEventContent[] };
  };
}

/**
 * Single Axiom query to fetch both "result" and "assistant" events for a run.
 * Replaces two separate queries (extractRunOutput + extractSummariesFromAxiom)
 * to halve the API call count per completion.
 */
async function queryRunEventsForChat(runId: string): Promise<{
  resultText: string | null;
  summaries: SummaryEntry[];
}> {
  const dataset = getDatasetName(DATASETS.AGENT_RUN_EVENTS);
  const apl = `['${dataset}']
| where runId == "${runId}"
| where eventType in ("result", "assistant")
| order by sequenceNumber asc
| limit 201`; // 200 assistant events + 1 result event

  const events = await queryAxiom<CombinedRunEvent>(apl);

  // Extract last result event
  const resultEvents = events.filter((e) => e.eventType === "result");
  const lastResult = resultEvents[resultEvents.length - 1];
  const resultText =
    typeof lastResult?.eventData?.result === "string"
      ? lastResult.eventData.result
      : null;

  // Extract summaries from assistant events
  const assistantEvents = events.filter((e) => e.eventType === "assistant");
  const summaries = extractSummariesFromEvents(assistantEvents);

  return { resultText, summaries };
}

/**
 * Persist user prompt and assistant result as chat messages on the session.
 * Runs in after() — best-effort, errors are logged but not propagated.
 *
 * Returns the assistant result text (if any) so callers can reuse it.
 */
async function persistChatMessages(
  runId: string,
  sessionId: string,
  userId: string,
  prompt: string,
): Promise<string | null> {
  const { resultText, summaries } = await queryRunEventsForChat(runId);

  const messages: Array<{
    role: "user" | "assistant";
    content: string;
    runId?: string;
    summaries?: SummaryEntry[];
  }> = [{ role: "user", content: prompt }];

  if (resultText) {
    messages.push({
      role: "assistant",
      content: resultText,
      runId,
      ...(summaries.length > 0 ? { summaries } : {}),
    });
  }

  await appendChatMessages(sessionId, userId, messages);
  log.debug(`Persisted ${messages.length} chat messages for run ${runId}`);
  return resultText;
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
      drainOrgQueue(orgId, dispatchQueuedZeroRun),
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

      // Persist chat messages and regenerate thread title (non-blocking)
      if (session) {
        after(async () => {
          const assistantResult = await persistChatMessages(
            body.runId,
            session.id,
            userId,
            run.prompt,
          ).catch((err) => {
            log.error("Failed to persist chat messages", { err });
            return null;
          });

          // Regenerate chat thread title from full context
          const [threadRun] = await globalThis.services.db
            .select({ chatThreadId: chatThreadRuns.chatThreadId })
            .from(chatThreadRuns)
            .where(eq(chatThreadRuns.runId, body.runId))
            .limit(1);

          if (threadRun) {
            const title = await generateChatTitle(
              run.prompt,
              assistantResult,
            ).catch((err: unknown) => {
              log.warn("Failed to generate chat title", { err });
              return null;
            });
            if (title) {
              await updateChatThreadTitle(threadRun.chatThreadId, title);
            }
          }
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
