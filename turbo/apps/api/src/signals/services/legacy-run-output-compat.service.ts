import { escapeAplString } from "../../lib/axiom-apl";
import { getDatasetName, queryAxiomDirect } from "../external/axiom";

const AGENT_RUN_EVENTS_DATASET = "agent-run-events";
const FRESH_AXIOM_QUERY_OPTIONS = { noCache: true } as const;

interface ContentBlock {
  readonly type?: string;
  readonly text?: string;
}

interface CodexItem {
  readonly type?: string;
  readonly text?: string;
}

interface LegacyRunOutputEvent {
  readonly eventType?: string;
  readonly sequenceNumber?: number;
  readonly eventData?: {
    readonly message?: { readonly content?: readonly ContentBlock[] };
    readonly item?: CodexItem;
    readonly result?: string;
    readonly sequenceNumber?: number;
  };
}

interface LegacyOutputEventItem {
  readonly sequenceNumber: number;
  readonly content: string;
}

interface LegacyChatOutput {
  readonly assistantItems: readonly LegacyOutputEventItem[];
  readonly resultFallback: LegacyOutputEventItem | null;
}

function eventSequenceNumber(event: LegacyRunOutputEvent): number | null {
  const sequenceNumber =
    event.sequenceNumber ?? event.eventData?.sequenceNumber;
  return typeof sequenceNumber === "number" ? sequenceNumber : null;
}

function extractAnthropicContent(
  blocks: readonly ContentBlock[],
): string | null {
  const parts = blocks.flatMap((block) => {
    return block.type === "text" &&
      typeof block.text === "string" &&
      block.text.trim().length > 0
      ? [block.text]
      : [];
  });
  if (parts.length === 0) {
    return null;
  }
  return parts.length === 1 ? parts[0]! : parts.join("\n\n");
}

function extractCodexAgentMessageContent(item: CodexItem): string | null {
  if (
    item.type !== "agent_message" ||
    typeof item.text !== "string" ||
    item.text.trim().length === 0
  ) {
    return null;
  }
  return item.text;
}

function extractAssistantContent(event: LegacyRunOutputEvent): string | null {
  const content =
    event.eventType === "assistant" ? event.eventData?.message?.content : null;
  if (content) {
    return extractAnthropicContent(content);
  }
  const item =
    event.eventType === "item.completed" ? event.eventData?.item : null;
  return item ? extractCodexAgentMessageContent(item) : null;
}

function extractResultContent(event: LegacyRunOutputEvent): string | null {
  if (event.eventType !== "result" && event.eventType !== undefined) {
    return null;
  }
  const result = event.eventData?.result;
  return typeof result === "string" && result.trim().length > 0 ? result : null;
}

function extractCallbackOutput(event: LegacyRunOutputEvent): string | null {
  const result = extractResultContent(event);
  if (result !== null) {
    return result;
  }
  const item = event.eventData?.item;
  return item ? extractCodexAgentMessageContent(item) : null;
}

function sequenceCap(lastEventSequence: number): string {
  return `\n| where sequenceNumber <= ${lastEventSequence}`;
}

/**
 * Temporary mixed-version deployment bridge.
 *
 * The API version immediately before the per-run DB projection acknowledged
 * events after its required Axiom ingest, but did not project non-chat output.
 * New writers never use this path. Remove it after runs accepted by that
 * previous writer can no longer reach a terminal callback.
 */
export async function queryPreviousWriterRunOutput(
  runId: string,
  lastEventSequence: number,
  signal: AbortSignal,
): Promise<string | undefined> {
  const dataset = getDatasetName(AGENT_RUN_EVENTS_DATASET);
  const apl = `['${dataset}']
| where runId == "${escapeAplString(runId)}"
| where eventType == "result" or (eventType == "item.completed" and ['eventData.item.type'] == "agent_message")${sequenceCap(lastEventSequence)}
| order by sequenceNumber desc
| limit 1`;

  const events = await queryAxiomDirect<LegacyRunOutputEvent>(
    apl,
    FRESH_AXIOM_QUERY_OPTIONS,
  );
  signal.throwIfAborted();
  return events
    .flatMap((event) => {
      const sequenceNumber = eventSequenceNumber(event);
      const content = extractCallbackOutput(event);
      return sequenceNumber !== null &&
        sequenceNumber <= lastEventSequence &&
        content !== null
        ? [{ sequenceNumber, content }]
        : [];
    })
    .sort((left, right) => {
      return right.sequenceNumber - left.sequenceNumber;
    })[0]?.content;
}

/**
 * Chat counterpart to queryPreviousWriterRunOutput. This is used only when
 * the DB row has the exact incomplete shape left by the previous writer.
 * There is intentionally no visibility polling: that writer required the
 * Axiom ingest before acknowledging /events.
 */
export async function queryPreviousWriterChatOutput(
  runId: string,
  lastEventSequence: number,
  signal: AbortSignal,
): Promise<LegacyChatOutput> {
  const dataset = getDatasetName(AGENT_RUN_EVENTS_DATASET);
  const pageSize = 200;
  let lastScannedSequence = -1;
  const assistantBySequence = new Map<number, string>();
  let resultFallback: LegacyOutputEventItem | null = null;

  while (true) {
    const apl = `['${dataset}']
| where runId == "${escapeAplString(runId)}"
| where eventType == "assistant" or eventType == "result" or eventType == "item.completed"
| where sequenceNumber > ${lastScannedSequence}${sequenceCap(lastEventSequence)}
| order by sequenceNumber asc
| limit ${pageSize}`;
    const events = await queryAxiomDirect<LegacyRunOutputEvent>(
      apl,
      FRESH_AXIOM_QUERY_OPTIONS,
    );
    signal.throwIfAborted();
    if (events.length === 0) {
      break;
    }

    let pageMaxSequence = lastScannedSequence;
    for (const event of events) {
      const sequenceNumber = eventSequenceNumber(event);
      if (
        sequenceNumber === null ||
        sequenceNumber <= lastScannedSequence ||
        sequenceNumber > lastEventSequence
      ) {
        continue;
      }
      pageMaxSequence = Math.max(pageMaxSequence, sequenceNumber);

      const assistant = extractAssistantContent(event);
      if (assistant !== null) {
        if (!assistantBySequence.has(sequenceNumber)) {
          assistantBySequence.set(sequenceNumber, assistant);
        }
        continue;
      }

      const result = extractResultContent(event);
      if (
        result !== null &&
        (resultFallback === null ||
          sequenceNumber > resultFallback.sequenceNumber)
      ) {
        resultFallback = { sequenceNumber, content: result };
      }
    }

    if (pageMaxSequence <= lastScannedSequence) {
      break;
    }
    lastScannedSequence = pageMaxSequence;
    if (events.length < pageSize || lastScannedSequence >= lastEventSequence) {
      break;
    }
  }

  return {
    assistantItems: [...assistantBySequence.entries()]
      .sort(([left], [right]) => {
        return left - right;
      })
      .map(([sequenceNumber, content]) => {
        return { sequenceNumber, content };
      }),
    resultFallback,
  };
}
