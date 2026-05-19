import "server-only";

import {
  queryAxiom,
  getDatasetName,
  DATASETS,
  escapeAplString,
} from "../../shared/axiom";
import { waitForRunEventWatermarkVisible } from "./agent-event-visibility";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RunOutput {
  /** Raw output text from the agent */
  result: string | null;
  /** Run error message (if failed) */
  error: string | null;
}

interface RunOutputQueryOptions {
  /**
   * Wait briefly for Axiom search visibility when a terminal output event has
   * not been indexed yet. User-facing callbacks should wait; best-effort
   * background summaries can opt out.
   */
  waitForOutput?: boolean;
  /**
   * Terminal event sequence already read with the run row. Passing it avoids
   * an extra DB lookup before waiting for Axiom visibility.
   */
  knownLastEventSequence?: number | null;
  /**
   * Override only the legacy output-query retry delay. Production callers use
   * the default; tests set this to zero to exercise retry behavior without
   * fake timers or slow sleeps.
   */
  outputRetryDelayMs?: number;
}

type RunOutputOptionsInput = RunOutputQueryOptions | number | null | undefined;

// ---------------------------------------------------------------------------
// Axiom query
// ---------------------------------------------------------------------------

interface CodexItem {
  type?: string;
  text?: string;
}

interface RunOutputEvent {
  eventType?: string;
  eventData: {
    result?: string;
    item?: CodexItem;
  };
}

const OUTPUT_EVENT_FILTER = `eventType == "result" or (eventType == "item.completed" and ['eventData.item.type'] == "agent_message")`;
const OUTPUT_QUERY_ATTEMPTS = 4;
const OUTPUT_QUERY_RETRY_MS = 500;
const FRESH_AXIOM_QUERY_OPTIONS = { noCache: true } as const;

function normalizeOptions(
  input?: RunOutputOptionsInput,
): RunOutputQueryOptions {
  if (typeof input === "number" || input === null) {
    return { knownLastEventSequence: input };
  }
  return input ?? {};
}

function waitForOutputRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

async function queryOutputEventsDesc(runId: string): Promise<RunOutputEvent[]> {
  const dataset = getDatasetName(DATASETS.AGENT_RUN_EVENTS);
  const apl = `['${dataset}']
| where runId == "${escapeAplString(runId)}"
| where ${OUTPUT_EVENT_FILTER}
| order by sequenceNumber desc
| limit 1`;

  return queryAxiom<RunOutputEvent>(apl, FRESH_AXIOM_QUERY_OPTIONS);
}

async function queryLatestOutputEvent(
  runId: string,
  options: RunOutputQueryOptions = {},
): Promise<RunOutputEvent | undefined> {
  const attempts =
    options.waitForOutput === false ||
    typeof options.knownLastEventSequence === "number"
      ? 1
      : OUTPUT_QUERY_ATTEMPTS;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const event = (await queryOutputEventsDesc(runId)).find(isOutputEvent);
    if (event || attempt === attempts) {
      return event;
    }
    await waitForOutputRetry(
      options.outputRetryDelayMs ?? OUTPUT_QUERY_RETRY_MS,
    );
  }
  return undefined;
}

async function waitForVisibleOutput(
  runId: string,
  options: RunOutputQueryOptions,
): Promise<number | undefined> {
  if (options.waitForOutput === false) {
    return undefined;
  }
  return waitForRunEventWatermarkVisible(runId, options.knownLastEventSequence);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract structured run output from Axiom.
 *
 * Merges logic previously split across:
 * - `extractResultFromAxiom` (webhook complete handler)
 * - `getRunResultData` / `getRunOutput` (Slack handler)
 *
 * Single Axiom query for terminal output events.
 */
export async function extractRunOutput(
  runId: string,
  error?: string | null,
  optionsInput?: RunOutputOptionsInput,
): Promise<RunOutput> {
  const options = normalizeOptions(optionsInput);
  const resolvedLastEventSequence = await waitForVisibleOutput(runId, options);
  const queryOptions =
    options.knownLastEventSequence === undefined &&
    typeof resolvedLastEventSequence === "number"
      ? { ...options, knownLastEventSequence: resolvedLastEventSequence }
      : options;

  const event = await queryLatestOutputEvent(runId, queryOptions);

  if (!event) {
    return {
      result: null,
      error: error ?? null,
    };
  }

  return buildRunOutput(event, error);
}

function extractCodexAgentMessageText(
  item: CodexItem | undefined,
): string | null {
  if (
    item?.type !== "agent_message" ||
    typeof item.text !== "string" ||
    item.text.length === 0
  ) {
    return null;
  }
  return item.text;
}

function isOutputEvent(event: RunOutputEvent): boolean {
  if (event.eventType === "item.completed") {
    return extractCodexAgentMessageText(event.eventData?.item) !== null;
  }

  return event.eventType === "result" || event.eventType === undefined;
}

function extractOutputText(event: RunOutputEvent): string | null {
  const result = event.eventData?.result;
  if (typeof result === "string") return result;

  const item = event.eventData?.item;
  const codexText = extractCodexAgentMessageText(item);
  if (codexText !== null) return codexText;

  return null;
}

function buildRunOutput(
  event: RunOutputEvent,
  error?: string | null,
): RunOutput {
  const result = extractOutputText(event);

  return {
    result,
    error: error ?? null,
  };
}

/**
 * Get formatted run output text (result string).
 *
 * Convenience wrapper for channels that just need a string.
 */
export async function getRunOutputText(
  runId: string,
  optionsInput?: RunOutputOptionsInput,
): Promise<string | undefined> {
  const output = await extractRunOutput(runId, undefined, optionsInput);
  return output.result ?? undefined;
}
