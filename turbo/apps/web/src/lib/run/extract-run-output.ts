import { queryAxiom, getDatasetName, DATASETS } from "../axiom";
import { detectIssueCategories, type DeepLink } from "../deep-links";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PermissionDenial {
  tool_name: string;
  tool_input?: {
    questions?: Array<{
      question: string;
      header?: string;
      options?: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }>;
  };
}

export interface RunOutput {
  /** Raw result text from the agent */
  result: string | null;
  /** AskUserQuestion permission denials */
  askUserDenials: PermissionDenial[];
  /** Whether model provider keywords were detected in the result */
  modelProviderIssue: boolean;
  /** Whether connector/secret keywords were detected in the result */
  connectorIssue: boolean;
  /** Run error message (if failed) */
  error: string | null;
}

// ---------------------------------------------------------------------------
// Axiom query
// ---------------------------------------------------------------------------

interface ResultEvent {
  eventData: {
    result?: string;
    permission_denials?: PermissionDenial[];
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
      askUserDenials: [],
      modelProviderIssue: false,
      connectorIssue: false,
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
        askUserDenials: [],
        modelProviderIssue: false,
        connectorIssue: false,
        error: error ?? null,
      },
    ];
  }

  return events.map((event) => buildRunOutput(event, error));
}

function buildRunOutput(event: ResultEvent, error?: string | null): RunOutput {
  const result =
    typeof event.eventData?.result === "string" ? event.eventData.result : null;

  const allDenials = event.eventData?.permission_denials ?? [];
  const askUserDenials = allDenials.filter(
    (d) => d.tool_name === "AskUserQuestion",
  );

  const textToScan = result ?? error ?? "";
  const categories = textToScan
    ? detectIssueCategories(textToScan)
    : new Set<never>();

  return {
    result,
    askUserDenials,
    modelProviderIssue: categories.has("provider"),
    connectorIssue: categories.has("connector"),
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
    let text = output.result ?? undefined;

    if (output.askUserDenials.length > 0) {
      const formatted = formatAskUserDenials(output.askUserDenials);
      if (formatted) {
        text = text ? `${text}\n\n${formatted}` : formatted;
      }
    }

    if (text) {
      texts.push(text);
    }
  }

  return texts;
}

/**
 * Build deep links from structured RunOutput flags.
 *
 * Replaces raw text keyword scanning in downstream consumers.
 */
export function buildDeepLinksFromFlags(
  output: RunOutput,
  appUrl: string,
  agentName?: string,
): DeepLink[] {
  const links: DeepLink[] = [];

  if (output.modelProviderIssue) {
    links.push({
      emoji: "🔑",
      label: "Configure model providers",
      url: `${appUrl}/settings`,
    });
  }

  if (output.connectorIssue) {
    const path = agentName
      ? `/team/${encodeURIComponent(agentName)}?tab=connectors`
      : "/team";
    links.push({
      emoji: "🔌",
      label: "Configure connectors",
      url: `${appUrl}${path}`,
    });
  }

  return links;
}

/**
 * Format AskUserQuestion denials as plain text.
 *
 * Used by non-interactive channels (Slack, Telegram, email) that cannot
 * render interactive question UIs.
 */
export function formatAskUserDenials(
  denials: PermissionDenial[],
): string | undefined {
  const parts: string[] = [];

  for (const denial of denials) {
    const questions = denial.tool_input?.questions;
    if (!questions || questions.length === 0) {
      continue;
    }

    for (const q of questions) {
      parts.push(q.question);
      if (q.options) {
        for (const opt of q.options) {
          const desc = opt.description ? ` — ${opt.description}` : "";
          parts.push(`  • ${opt.label}${desc}`);
        }
      }
    }
  }

  if (parts.length === 0) {
    return undefined;
  }

  return `The agent needs your input to proceed:\n\n${parts.join("\n")}`;
}

/**
 * Get formatted run output text (result + formatted denials).
 *
 * Convenience wrapper for channels that just need a string.
 * Replaces the old `getRunOutput()` function.
 */
export async function getRunOutputText(
  runId: string,
): Promise<string | undefined> {
  const output = await extractRunOutput(runId);

  if (output.askUserDenials.length > 0) {
    const formatted = formatAskUserDenials(output.askUserDenials);
    if (formatted) {
      return output.result ? `${output.result}\n\n${formatted}` : formatted;
    }
  }

  return output.result ?? undefined;
}
