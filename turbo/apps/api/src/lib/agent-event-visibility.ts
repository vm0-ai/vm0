// Axiom indexing-lag barrier for run-event reads. Ports the corresponding
// helpers from apps/web/src/lib/infra/run/agent-event-visibility.ts so the
// api side matches web's behavior on freshly-completed runs (issue #12424).
//
// The barrier polls Axiom for a contiguous prefix of `sequenceNumber` values
// up through a target sequence (the run's `agent_runs.last_event_sequence`).
// When the prefix is visible, callers can issue the actual events query
// confident that all the events that will ever exist for the prefix are now
// query-able. Each poll uses `noCache: true` so cache-staleness doesn't
// extend the window.
import { delay } from "signal-timers";

import {
  getDatasetName,
  queryAxiomDirect,
  type QueryAxiomOptions,
} from "../signals/external/axiom";
import { settle } from "../signals/utils";
import { escapeAplString } from "./axiom-apl";
import { logger } from "./log";

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_INTERVAL_MS = 100;
const DEFAULT_BATCH_SIZE = 500;

const log = logger("run-event-visibility");

interface AxiomAgentEventSequence {
  readonly sequenceNumber: number;
}

type QueryAxiomFn = <T>(
  apl: string,
  options?: QueryAxiomOptions,
) => Promise<readonly T[]>;

interface WaitOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly queryAxiomFn?: QueryAxiomFn;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

interface AgentEventVisibilityResult {
  readonly visible: boolean;
  readonly visibleThrough: number;
  readonly targetSequence: number;
  readonly attempts: number;
  readonly elapsedMs: number;
  readonly reason: "visible" | "timeout" | "query_error";
  readonly error?: unknown;
}

/**
 * Decide which sequence number a paged read needs to wait for, given the
 * caller's `since` cursor (exclusive), the page `limit`, and the run's known
 * watermark. Returns null when no wait is needed (cursor already past the
 * watermark, or the run has no events recorded yet).
 *
 * Used only by the asc-order branch of zeroRunAgentEvents — desc reads
 * always need the full watermark when below it.
 */
export function getAgentEventPageWatermarkTarget(
  lastEventSequence: number | null,
  since: number | undefined,
  limit: number,
): number | null {
  if (lastEventSequence === null || limit <= 0) {
    return null;
  }
  const cursor = Math.max(-1, Math.floor(since ?? -1));
  if (cursor >= lastEventSequence) {
    return null;
  }
  return Math.min(lastEventSequence, cursor + limit);
}

function defaultSleep(ms: number): Promise<void> {
  // Polling barrier — pass an unaborted signal because the polling loop
  // governs its own deadline via WaitOptions.now/timeoutMs. Tests inject a
  // fake `sleep` so this path is unreached in CI.
  return delay(ms, { signal: new AbortController().signal });
}

function advanceVisiblePrefix(
  events: readonly AxiomAgentEventSequence[],
  visibleThrough: number,
): number {
  let nextVisibleThrough = visibleThrough;
  let expected = nextVisibleThrough + 1;

  for (const event of events) {
    if (event.sequenceNumber < expected) {
      continue;
    }
    if (event.sequenceNumber !== expected) {
      break;
    }
    nextVisibleThrough = event.sequenceNumber;
    expected++;
  }

  return nextVisibleThrough;
}

function buildVisibilityQuery(
  dataset: string,
  runId: string,
  visibleThrough: number,
  batchSize: number,
): string {
  return `['${dataset}']
| where runId == "${escapeAplString(runId)}"
| where sequenceNumber > ${visibleThrough}
| project sequenceNumber
| order by sequenceNumber asc
| limit ${batchSize}`;
}

/**
 * Poll Axiom until the contiguous sequence prefix through `targetSequence`
 * is visible, or the timeout elapses. Returns a visibility result describing
 * the outcome — callers log non-`visible` outcomes and proceed regardless
 * (best-effort barrier, not a hard requirement).
 *
 * Single deadline-bounded loop:
 * - On query error: short-circuit immediately. The caller's subsequent
 *   events query hits the same Axiom service and will surface the real
 *   failure without wasting the remaining poll window.
 * - On visible prefix advance with a full batch: skip the sleep so the next
 *   page is requested immediately (more pending data is likely indexed).
 * - Otherwise: sleep one interval and re-poll until the deadline.
 */
async function waitForAgentEventPrefixVisible(
  runId: string,
  targetSequence: number,
  options: WaitOptions = {},
): Promise<AgentEventVisibilityResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const queryFn: QueryAxiomFn = options.queryAxiomFn ?? queryAxiomDirect;
  const sleepFn = options.sleep ?? defaultSleep;
  const nowFn = options.now ?? Date.now;
  const dataset = getDatasetName("agent-run-events");

  const startedAt = nowFn();
  const deadline = startedAt + timeoutMs;
  let visibleThrough = -1;
  let attempts = 0;

  while (nowFn() < deadline) {
    attempts++;
    const apl = buildVisibilityQuery(dataset, runId, visibleThrough, batchSize);

    // A query failure here is virtually guaranteed to repeat against the
    // events query that follows (same Axiom service, same dataset). Bail
    // out immediately so the caller's next call surfaces the real error
    // without burning the remainder of the timeout window. settle
    // re-raises AbortError so cancellation still propagates.
    const queried = await settle(
      queryFn<AxiomAgentEventSequence>(apl, { noCache: true }),
    );
    if (!queried.ok) {
      return {
        visible: false,
        visibleThrough,
        targetSequence,
        attempts,
        elapsedMs: nowFn() - startedAt,
        reason: "query_error",
        error: queried.error,
      };
    }

    const events = queried.value;
    const previousVisibleThrough = visibleThrough;
    visibleThrough = advanceVisiblePrefix(events, visibleThrough);

    if (visibleThrough >= targetSequence) {
      return {
        visible: true,
        visibleThrough,
        targetSequence,
        attempts,
        elapsedMs: nowFn() - startedAt,
        reason: "visible",
      };
    }

    // Full batch with forward progress → more events likely already indexed.
    // Re-query immediately without sleeping.
    const madeProgress = visibleThrough > previousVisibleThrough;
    if (madeProgress && events.length >= batchSize) {
      continue;
    }

    const remainingMs = deadline - nowFn();
    if (remainingMs <= 0) {
      break;
    }
    await sleepFn(Math.min(intervalMs, remainingMs));
  }

  return {
    visible: false,
    visibleThrough,
    targetSequence,
    attempts,
    elapsedMs: nowFn() - startedAt,
    reason: "timeout",
  };
}

/**
 * Best-effort barrier for code that reads run events back from Axiom after
 * the terminal webhook. Callers always supply `knownTargetSequence` from
 * their own DB read (the api side never falls back to the per-runId lookup
 * web has — that branch is dead code in api context).
 *
 * Returns the target sequence on success / `not_configured` (so the caller
 * can stamp it into a watermark column if desired); returns `undefined`
 * when no wait was attempted (target is null).
 */
export async function waitForRunEventWatermarkVisible(
  runId: string,
  knownTargetSequence: number | null,
  options: WaitOptions = {},
): Promise<number | undefined> {
  if (knownTargetSequence === null) {
    return undefined;
  }

  const visibility = await waitForAgentEventPrefixVisible(
    runId,
    knownTargetSequence,
    options,
  );
  if (visibility.visible) {
    return knownTargetSequence;
  }

  log.warn("Reading run Axiom events before terminal watermark is visible", {
    runId,
    targetSequence: visibility.targetSequence,
    visibleThrough: visibility.visibleThrough,
    attempts: visibility.attempts,
    elapsedMs: visibility.elapsedMs,
    reason: visibility.reason,
    error: visibility.error,
  });
  return knownTargetSequence;
}
