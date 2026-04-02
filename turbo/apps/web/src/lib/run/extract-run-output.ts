import { queryAxiom, getDatasetName, DATASETS } from "../shared/axiom";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunOutput {
  /** Raw result text from the agent */
  result: string | null;
  /** Run error message (if failed) */
  error: string | null;
}

// ---------------------------------------------------------------------------
// Axiom query
// ---------------------------------------------------------------------------

interface ResultEvent {
  eventData: {
    result?: string;
  };
}

async function queryResultEvent(
  runId: string,
): Promise<ResultEvent | undefined> {
  const dataset = getDatasetName(DATASETS.AGENT_RUN_EVENTS);
  const apl = `['${dataset}']
| where runId == "${runId}"
| where eventType == "result"
| order by sequenceNumber desc
| limit 1`;

  const events = await queryAxiom<ResultEvent>(apl);
  return events[0];
}

async function queryAllResultEvents(runId: string): Promise<ResultEvent[]> {
  const dataset = getDatasetName(DATASETS.AGENT_RUN_EVENTS);
  const apl = `['${dataset}']
| where runId == "${runId}"
| where eventType == "result"
| order by sequenceNumber asc`;

  return queryAxiom<ResultEvent>(apl);
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
 * Single Axiom query for the result event.
 */
export async function extractRunOutput(
  runId: string,
  error?: string | null,
): Promise<RunOutput> {
  const event = await queryResultEvent(runId);

  if (!event) {
    return {
      result: null,
      error: error ?? null,
    };
  }

  return buildRunOutput(event, error);
}

/**
 * Extract ALL structured run outputs from Axiom (ordered by sequence number).
 *
 * A run may produce multiple result events (e.g. intermediate task
 * notifications followed by a final summary). This returns one RunOutput
 * per result event so callers can post each one individually.
 */
export async function extractAllRunOutputs(
  runId: string,
  error?: string | null,
): Promise<RunOutput[]> {
  const events = await queryAllResultEvents(runId);

  if (events.length === 0) {
    return [
      {
        result: null,
        error: error ?? null,
      },
    ];
  }

  return events.map((event) => {
    return buildRunOutput(event, error);
  });
}

function buildRunOutput(event: ResultEvent, error?: string | null): RunOutput {
  const result =
    typeof event.eventData?.result === "string" ? event.eventData.result : null;

  return {
    result,
    error: error ?? null,
  };
}

/**
 * Get ALL formatted run output texts (one per result event).
 *
 * Convenience wrapper for channels that post each result as a separate message.
 */
export async function getAllRunOutputTexts(runId: string): Promise<string[]> {
  const outputs = await extractAllRunOutputs(runId);
  const texts: string[] = [];

  for (const output of outputs) {
    if (output.result) {
      texts.push(output.result);
    }
  }

  return texts;
}

/**
 * Get formatted run output text (result string).
 *
 * Convenience wrapper for channels that just need a string.
 */
export async function getRunOutputText(
  runId: string,
): Promise<string | undefined> {
  const output = await extractRunOutput(runId);
  return output.result ?? undefined;
}
