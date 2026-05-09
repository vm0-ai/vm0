import "server-only";

import { agentRuns } from "@vm0/db/schema/agent-run";
import { eq } from "drizzle-orm";
import {
  DATASETS,
  escapeAplString,
  getDatasetName,
  isAxiomDatasetConfigured,
  queryAxiom,
  type QueryAxiomOptions,
} from "../../shared/axiom";
import { logger } from "../../shared/logger";

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_INTERVAL_MS = 100;
const DEFAULT_BATCH_SIZE = 500;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const log = logger("run-event-visibility");

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

function getInitializedDb(): typeof globalThis.services.db | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "services");
  if (!descriptor) {
    return undefined;
  }

  try {
    return globalThis.services.db;
  } catch {
    return undefined;
  }
}

async function resolveLastEventSequence(
  runId: string,
): Promise<number | undefined> {
  if (!UUID_RE.test(runId)) {
    return undefined;
  }

  const db = getInitializedDb();
  if (!db) {
    return undefined;
  }

  const [run] = await db
    .select({ lastEventSequence: agentRuns.lastEventSequence })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);

  return run?.lastEventSequence ?? undefined;
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
| where runId == "${escapeAplString(runId)}"
| where sequenceNumber > ${visibleThrough}
| project sequenceNumber
| order by sequenceNumber asc
| limit ${batchSize}`;
}

/**
 * Best-effort Axiom visibility barrier for terminal callbacks.
 *
 * The guest reports the highest event sequence whose events webhook POST
 * completed. Terminal callbacks read agent output back from Axiom, so wait
 * briefly until Axiom can query the contiguous sequence prefix through that
 * watermark before callbacks try to extract result events.
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
        const queryPromise = queryAxiomFn<AxiomAgentEventSequence>(apl, {
          maxRetries: 0,
          noCache: true,
          streamingDuration: "1s",
          timeoutMs: remainingMs,
        });
        events = options.queryAxiomFn
          ? await withTimeout(queryPromise, remainingMs)
          : await queryPromise;
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

      if (
        visibleThrough <= previousVisibleThrough ||
        events.length < batchSize
      ) {
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

/**
 * Best-effort barrier for code that reads run events back from Axiom after the
 * terminal webhook. The complete route records the terminal watermark without
 * blocking; readers that need final output call this before querying Axiom.
 */
export async function waitForRunEventWatermarkVisible(
  runId: string,
  knownTargetSequence?: number | null,
): Promise<number | undefined> {
  if (knownTargetSequence === null) {
    return undefined;
  }

  let targetSequence: number | undefined;
  try {
    targetSequence =
      knownTargetSequence === undefined
        ? await resolveLastEventSequence(runId)
        : knownTargetSequence;
  } catch (error) {
    log.warn("Unable to resolve run event watermark before reading Axiom", {
      runId,
      error,
    });
    return undefined;
  }

  if (targetSequence === undefined) {
    return undefined;
  }

  const visibility = await waitForAgentEventPrefixVisible(
    runId,
    targetSequence,
  );
  if (visibility.visible || visibility.reason === "not_configured") {
    return targetSequence;
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
  return targetSequence;
}
