import "server-only";
import {
  DATASETS,
  getDatasetName,
  isAxiomDatasetConfigured,
  queryAxiom,
  type QueryAxiomOptions,
} from "../../shared/axiom";

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_INTERVAL_MS = 100;
const DEFAULT_BATCH_SIZE = 500;

interface AxiomAgentEventSequence {
  sequenceNumber: number;
}

type QueryAxiomFn = <T>(
  apl: string,
  options?: QueryAxiomOptions,
) => Promise<T[]>;

interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  batchSize?: number;
  queryAxiomFn?: QueryAxiomFn;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface AgentEventVisibilityResult {
  visible: boolean;
  visibleThrough: number;
  targetSequence: number;
  attempts: number;
  elapsedMs: number;
  reason: "visible" | "not_configured" | "timeout" | "query_error";
  error?: unknown;
}

function escapeApl(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  if (timeoutMs <= 0) {
    throw new Error("Axiom visibility query timed out");
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("Axiom visibility query timed out"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function advanceVisiblePrefix(
  events: AxiomAgentEventSequence[],
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

function buildAgentEventVisibilityQuery(
  dataset: string,
  runId: string,
  visibleThrough: number,
  batchSize: number,
): string {
  return `['${dataset}']
| where runId == "${escapeApl(runId)}"
| where sequenceNumber > ${visibleThrough}
| project sequenceNumber
| order by sequenceNumber asc
| limit ${batchSize}`;
}

/**
 * Best-effort Axiom visibility barrier for successful run completion.
 *
 * The guest reports the highest event sequence whose events webhook POST
 * completed. Before exposing the run as completed, wait briefly until Axiom
 * can query the contiguous sequence prefix through that watermark.
 */
export async function waitForAgentEventPrefixVisible(
  runId: string,
  targetSequence: number,
  options: WaitOptions = {},
): Promise<AgentEventVisibilityResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const queryAxiomFn = options.queryAxiomFn ?? queryAxiom;
  const sleepFn = options.sleep ?? sleep;
  const now = options.now ?? Date.now;
  const dataset = getDatasetName(DATASETS.AGENT_RUN_EVENTS);

  const startedAt = now();
  if (!options.queryAxiomFn && !isAxiomDatasetConfigured(dataset)) {
    return {
      visible: false,
      visibleThrough: -1,
      targetSequence,
      attempts: 0,
      elapsedMs: 0,
      reason: "not_configured",
    };
  }

  const deadline = startedAt + timeoutMs;
  let visibleThrough = -1;
  let attempts = 0;
  let lastQueryError: unknown;

  outer: while (now() < deadline) {
    let advancedInThisPass = false;

    do {
      attempts++;
      const remainingMs = deadline - now();
      const apl = buildAgentEventVisibilityQuery(
        dataset,
        runId,
        visibleThrough,
        batchSize,
      );

      let events: AxiomAgentEventSequence[];
      try {
        events = await withTimeout(
          queryAxiomFn<AxiomAgentEventSequence>(apl, { maxRetries: 0 }),
          remainingMs,
        );
        lastQueryError = undefined;
      } catch (error) {
        lastQueryError = error;
        const remainingAfterErrorMs = deadline - now();
        if (remainingAfterErrorMs <= 0) {
          break outer;
        }
        await sleepFn(Math.min(intervalMs, remainingAfterErrorMs));
        continue outer;
      }

      const previousVisibleThrough = visibleThrough;
      visibleThrough = advanceVisiblePrefix(events, visibleThrough);

      if (visibleThrough >= targetSequence) {
        return {
          visible: true,
          visibleThrough,
          targetSequence,
          attempts,
          elapsedMs: now() - startedAt,
          reason: "visible",
        };
      }

      advancedInThisPass = visibleThrough > previousVisibleThrough;
      if (!advancedInThisPass || events.length < batchSize) {
        break;
      }
    } while (now() < deadline);

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      break;
    }
    await sleepFn(Math.min(intervalMs, remainingMs));
  }

  if (lastQueryError) {
    return {
      visible: false,
      visibleThrough,
      targetSequence,
      attempts,
      elapsedMs: now() - startedAt,
      reason: "query_error",
      error: lastQueryError,
    };
  }

  return {
    visible: false,
    visibleThrough,
    targetSequence,
    attempts,
    elapsedMs: now() - startedAt,
    reason: "timeout",
  };
}
