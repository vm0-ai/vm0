import chalk from "chalk";
import { getZeroRunAgentEvents, getZeroRun } from "../../../lib/api";
import type { RunResult } from "../../../lib/api";
import { parseEvent } from "../../../lib/events/event-parser-factory";
import { EventRenderer } from "../../../lib/events/event-renderer";
import type { PollResult, EventRenderingOptions } from "../../run/shared";

/**
 * Safely narrow GetRunResponse.result to RunResult.
 * GetRunResponse.result has all fields optional (due to .passthrough()),
 * but RunResult requires checkpointId, agentSessionId, conversationId.
 * Extra fields (artifact, volumes) are preserved at runtime via passthrough.
 */
function toRunResult(result: {
  output?: string;
  executionTimeMs?: number;
  agentSessionId?: string;
  checkpointId?: string;
  conversationId?: string;
}): RunResult | undefined {
  const { checkpointId, agentSessionId, conversationId } = result;
  if (!checkpointId || !agentSessionId || !conversationId) {
    return undefined;
  }
  return { checkpointId, agentSessionId, conversationId };
}

/**
 * Poll for zero run events until run completes.
 * Uses dual-poll approach: telemetry endpoint for events, getById for status.
 */
export async function pollZeroEvents(
  runId: string,
  options?: EventRenderingOptions,
): Promise<PollResult> {
  const renderer = new EventRenderer({ verbose: options?.verbose });

  let lastSequence = -1;
  let complete = false;
  let result: PollResult = { succeeded: true, runId };
  const pollIntervalMs = 1000;

  while (!complete) {
    // 1. Fetch events from telemetry endpoint
    const eventsResponse = await getZeroRunAgentEvents(runId, {
      since: lastSequence,
      limit: 100,
      order: "asc",
    });

    // 2. Parse and render each event
    for (const event of eventsResponse.events) {
      const eventData = event.eventData as Record<string, unknown>;
      const parsed = parseEvent(eventData);
      if (parsed) {
        renderer.render(parsed);
      }
    }

    // 3. Track last sequence number for pagination
    if (eventsResponse.events.length > 0) {
      lastSequence = Math.max(
        ...eventsResponse.events.map((e) => {
          return e.sequenceNumber;
        }),
      );
    }

    // 4. Fetch run status separately
    const runResponse = await getZeroRun(runId);
    const runStatus = runResponse.status;

    if (runStatus === "completed") {
      complete = true;
      EventRenderer.renderRunCompleted(
        runResponse.result ? toRunResult(runResponse.result) : undefined,
      );
      result = {
        succeeded: true,
        runId,
        sessionId: runResponse.result?.agentSessionId,
        checkpointId: runResponse.result?.checkpointId,
      };
    } else if (runStatus === "failed") {
      complete = true;
      EventRenderer.renderRunFailed(runResponse.error, runId);
      result = { succeeded: false, runId };
    } else if (runStatus === "timeout") {
      complete = true;
      console.error(chalk.red("\n✗ Run timed out"));
      result = { succeeded: false, runId };
    } else if (runStatus === "cancelled") {
      complete = true;
      console.error(chalk.yellow("\n✗ Run cancelled"));
      result = { succeeded: false, runId };
    }

    if (!complete) {
      await new Promise((resolve) => {
        return setTimeout(resolve, pollIntervalMs);
      });
    }
  }

  return result;
}

/**
 * Display next steps after successful zero run
 */
export function showZeroNextSteps(result: PollResult): void {
  const { sessionId } = result;

  console.log();

  if (sessionId) {
    console.log("  Continue delegation:");
    console.log(
      chalk.cyan(`    zero run continue ${sessionId} "your next prompt"`),
    );
  }
}
