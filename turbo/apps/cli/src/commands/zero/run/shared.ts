import chalk from "chalk";
import { getZeroRunAgentEvents, getZeroRun } from "../../../lib/api";
import type { RunResult } from "../../../lib/api";
import { parseEvent } from "../../../lib/events/event-parser-factory";
import { EventRenderer } from "../../../lib/events/event-renderer";
import type { PollResult, EventRenderingOptions } from "../../run/shared";

interface SequencedEvent {
  sequenceNumber: number;
}

type ZeroRunResponse = Awaited<ReturnType<typeof getZeroRun>>;
type TerminalRunStatus = "completed" | "failed" | "timeout" | "cancelled";
type TerminalRunResponse = ZeroRunResponse & { status: TerminalRunStatus };

const TERMINAL_RUN_STATUSES: readonly TerminalRunStatus[] = [
  "completed",
  "failed",
  "timeout",
  "cancelled",
];

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

function filterContiguousEvents<T extends SequencedEvent>(
  events: T[],
  lastSequence: number,
): T[] {
  const contiguousEvents: T[] = [];
  let expectedSequence = lastSequence + 1;

  for (const event of events) {
    if (event.sequenceNumber < expectedSequence) {
      continue;
    }
    if (event.sequenceNumber !== expectedSequence) {
      break;
    }
    contiguousEvents.push(event);
    expectedSequence++;
  }

  return contiguousEvents;
}

const POLL_INTERVAL_MS = 1000;
const TERMINAL_DRAIN_POLL_INTERVAL_MS = 500;
const TERMINAL_DRAIN_IDLE_MS = 1000;
const TERMINAL_DRAIN_MAX_MS = 3000;

function isTerminalRunResponse(
  runResponse: ZeroRunResponse,
): runResponse is TerminalRunResponse {
  return TERMINAL_RUN_STATUSES.includes(
    runResponse.status as TerminalRunStatus,
  );
}

function shouldDrainNextEventPage<T>(
  eventsResponse: { hasMore: boolean; events: T[] },
  contiguousEvents: T[],
): boolean {
  return (
    eventsResponse.hasMore &&
    contiguousEvents.length > 0 &&
    contiguousEvents.length === eventsResponse.events.length
  );
}

function hasSequenceGap<T>(
  eventsResponse: { events: T[] },
  contiguousEvents: T[],
): boolean {
  return (
    eventsResponse.events.length > 0 &&
    contiguousEvents.length < eventsResponse.events.length
  );
}

function shouldCompleteTerminalDrain(
  terminalSeenAt: number,
  lastTerminalProgressAt: number,
  blockedByGap: boolean,
): boolean {
  const now = Date.now();
  const terminalElapsedMs = now - terminalSeenAt;
  const terminalIdleMs = now - lastTerminalProgressAt;
  return (
    terminalElapsedMs >= TERMINAL_DRAIN_MAX_MS ||
    (!blockedByGap && terminalIdleMs >= TERMINAL_DRAIN_IDLE_MS)
  );
}

function renderTerminalRunResult(
  runId: string,
  runResponse: TerminalRunResponse,
): PollResult {
  if (runResponse.status === "completed") {
    EventRenderer.renderRunCompleted(
      runResponse.result ? toRunResult(runResponse.result) : undefined,
    );
    return {
      succeeded: true,
      runId,
      sessionId: runResponse.result?.agentSessionId,
      checkpointId: runResponse.result?.checkpointId,
    };
  }

  if (runResponse.status === "failed") {
    EventRenderer.renderRunFailed(runResponse.error, runId);
    return { succeeded: false, runId };
  }

  if (runResponse.status === "timeout") {
    console.error(chalk.red("\n✗ Run timed out"));
    return { succeeded: false, runId };
  }

  console.error(chalk.yellow("\n✗ Run cancelled"));
  return { succeeded: false, runId };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    return setTimeout(resolve, ms);
  });
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
  let terminalRunResponse: TerminalRunResponse | undefined;
  let terminalSeenAt = 0;
  let lastTerminalProgressAt = 0;

  while (!complete) {
    // 1. Fetch events from telemetry endpoint
    const eventsResponse = await getZeroRunAgentEvents(runId, {
      since: lastSequence,
      limit: 100,
      order: "asc",
    });

    const contiguousEvents = filterContiguousEvents(
      eventsResponse.events,
      lastSequence,
    );

    // 2. Parse and render each event
    for (const event of contiguousEvents) {
      const eventData = event.eventData as Record<string, unknown>;
      const parsed = parseEvent(eventData);
      if (parsed) {
        renderer.render(parsed);
      }
    }

    // 3. Track last sequence number for pagination
    if (contiguousEvents.length > 0) {
      lastSequence =
        contiguousEvents[contiguousEvents.length - 1]!.sequenceNumber;
      if (terminalRunResponse) {
        lastTerminalProgressAt = Date.now();
      }
    }

    const blockedByGap = hasSequenceGap(eventsResponse, contiguousEvents);

    // If this page is fully contiguous and the server says more are already
    // queryable, drain the next page before checking terminal status. Otherwise
    // a completed run with >100 unseen events would render only the final page's
    // first batch and then exit.
    if (shouldDrainNextEventPage(eventsResponse, contiguousEvents)) {
      continue;
    }

    // 4. Fetch run status separately. During terminal drain, keep the latest
    // terminal state because timeout runs can still be upgraded to completed.
    const runResponse = await getZeroRun(runId);
    if (isTerminalRunResponse(runResponse)) {
      if (!terminalRunResponse) {
        terminalSeenAt = Date.now();
        lastTerminalProgressAt = terminalSeenAt;
      }
      terminalRunResponse = runResponse;
    }

    if (terminalRunResponse) {
      if (
        shouldCompleteTerminalDrain(
          terminalSeenAt,
          lastTerminalProgressAt,
          blockedByGap,
        )
      ) {
        result = renderTerminalRunResult(runId, terminalRunResponse);
        complete = true;
      }
    }

    if (!complete) {
      await sleep(
        terminalRunResponse
          ? TERMINAL_DRAIN_POLL_INTERVAL_MS
          : POLL_INTERVAL_MS,
      );
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
