import { delay } from "signal-timers";

import { waitForRunEventWatermarkVisible } from "../../lib/agent-event-visibility";
import { escapeAplString } from "../../lib/axiom-apl";
import { getDatasetName, queryAxiomDirect } from "../external/axiom";

interface RunOutput {
  readonly result: string | null;
  readonly error: string | null;
}

interface RunOutputQueryOptions {
  readonly waitForOutput?: boolean;
  readonly knownLastEventSequence?: number | null;
  readonly outputRetryDelayMs?: number;
  readonly signal?: AbortSignal;
}

type RunOutputOptionsInput = RunOutputQueryOptions | number | null | undefined;

interface CodexItem {
  readonly type?: string;
  readonly text?: string;
}

interface RunOutputEvent {
  readonly eventType?: string;
  readonly eventData?: {
    readonly result?: string;
    readonly item?: CodexItem;
  };
}

const AGENT_RUN_EVENTS_DATASET = "agent-run-events";
const OUTPUT_EVENT_FILTER = `eventType == "result" or (eventType == "item.completed" and ['eventData.item.type'] == "agent_message")`;
const OUTPUT_QUERY_ATTEMPTS = 4;
const OUTPUT_QUERY_RETRY_MS = 500;
const FRESH_AXIOM_QUERY_OPTIONS = { noCache: true } as const;
const NEVER_ABORTED_SIGNAL = new AbortController().signal;

function normalizeOptions(
  input?: RunOutputOptionsInput,
): RunOutputQueryOptions {
  if (typeof input === "number" || input === null) {
    return { knownLastEventSequence: input };
  }
  return input ?? {};
}

function waitForOutputRetry(
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return delay(delayMs, { signal: signal ?? NEVER_ABORTED_SIGNAL });
}

async function queryOutputEventsDesc(runId: string): Promise<RunOutputEvent[]> {
  const dataset = getDatasetName(AGENT_RUN_EVENTS_DATASET);
  const apl = `['${dataset}']
| where runId == "${escapeAplString(runId)}"
| where ${OUTPUT_EVENT_FILTER}
| order by sequenceNumber desc
| limit 1`;

  return [
    ...(await queryAxiomDirect<RunOutputEvent>(apl, FRESH_AXIOM_QUERY_OPTIONS)),
  ];
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
    options.signal?.throwIfAborted();
    const event = (await queryOutputEventsDesc(runId)).find(isOutputEvent);
    if (event || attempt === attempts) {
      return event;
    }
    await waitForOutputRetry(
      options.outputRetryDelayMs ?? OUTPUT_QUERY_RETRY_MS,
      options.signal,
    );
  }
  return undefined;
}

function waitForVisibleOutput(
  runId: string,
  options: RunOutputQueryOptions,
): Promise<number | undefined> {
  if (options.waitForOutput === false) {
    return Promise.resolve(undefined);
  }
  return waitForRunEventWatermarkVisible(
    runId,
    options.knownLastEventSequence ?? null,
  );
}

async function extractRunOutput(
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
  if (typeof result === "string") {
    return result;
  }

  const codexText = extractCodexAgentMessageText(event.eventData?.item);
  if (codexText !== null) {
    return codexText;
  }

  return null;
}

function buildRunOutput(
  event: RunOutputEvent,
  error?: string | null,
): RunOutput {
  return {
    result: extractOutputText(event),
    error: error ?? null,
  };
}

export async function getRunOutputText(
  runId: string,
  optionsInput?: RunOutputOptionsInput,
): Promise<string | undefined> {
  const output = await extractRunOutput(runId, undefined, optionsInput);
  return output.result ?? undefined;
}
