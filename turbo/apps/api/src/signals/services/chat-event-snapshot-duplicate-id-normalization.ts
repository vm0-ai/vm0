import {
  chatEventRowSchema,
  type ChatEventRow,
} from "@okouai/api-contracts/contracts/chat-event-rows";
import { v5 as uuidv5 } from "uuid";

/** Immutable so rebuilding the same logical archive always yields the same IDs. */
const DUPLICATE_EVENT_ID_NAMESPACE = "46842b1d-a596-47fb-86b3-4f51962751c7";
const ARCHIVE_EVENT_ID_PREFIX = '{"id":"';

export interface DuplicateEventIdNormalizationStats {
  readonly conflictingEventIds: number;
  readonly remappedEventIds: number;
  readonly remappedEventReferences: number;
}

interface PreparedChatEventArchive {
  readonly body: Buffer;
  readonly normalization: DuplicateEventIdNormalizationStats;
}

export const NO_DUPLICATE_EVENT_ID_NORMALIZATION = {
  conflictingEventIds: 0,
  remappedEventIds: 0,
  remappedEventReferences: 0,
} as const satisfies DuplicateEventIdNormalizationStats;

function encodeArchiveLine(line: ChatEventRow): Buffer {
  return Buffer.from(`${JSON.stringify(line)}\n`);
}

function archiveEventIds(body: Buffer): readonly string[] {
  const raw = body.toString("utf8");
  if (raw.length === 0) {
    return [];
  }
  if (!raw.endsWith("\n")) {
    throw new Error("chat event snapshot archive must end with a newline");
  }
  return raw
    .slice(0, -1)
    .split("\n")
    .map((line) => {
      if (!line.startsWith(ARCHIVE_EVENT_ID_PREFIX)) {
        throw new Error("chat event snapshot archive line must start with id");
      }
      const idEnd = line.indexOf('"', ARCHIVE_EVENT_ID_PREFIX.length);
      if (idEnd === -1) {
        throw new Error("chat event snapshot archive line id is incomplete");
      }
      return line.slice(ARCHIVE_EVENT_ID_PREFIX.length, idEnd);
    });
}

function decodeArchiveLines(body: Buffer): readonly ChatEventRow[] {
  const raw = body.toString("utf8");
  if (raw.length === 0) {
    return [];
  }
  if (!raw.endsWith("\n")) {
    throw new Error("chat event snapshot archive must end with a newline");
  }
  return raw
    .slice(0, -1)
    .split("\n")
    .map((line) => {
      return chatEventRowSchema.parse(JSON.parse(line));
    });
}

export function prepareChatEventArchiveWithNormalizedIds(
  chatThreadId: string,
  parentBody: Buffer,
  tailLines: readonly Buffer[],
): PreparedChatEventArchive {
  const body = Buffer.concat([parentBody, ...tailLines]);
  const eventIds = archiveEventIds(body);
  const newestOccurrenceById = new Map<string, number>();
  const duplicateEventIds = new Set<string>();
  for (const [index, eventId] of eventIds.entries()) {
    if (newestOccurrenceById.has(eventId)) {
      duplicateEventIds.add(eventId);
    }
    newestOccurrenceById.set(eventId, index);
  }
  if (duplicateEventIds.size === 0) {
    // Re-encoding valid NDJSON can change bytes, so the common path returns the
    // exact prefix-and-tail concatenation that the previous writer produced.
    return { body, normalization: NO_DUPLICATE_EVENT_ID_NORMALIZATION };
  }

  const rows = decodeArchiveLines(body);
  let remappedEventIds = 0;
  let remappedEventReferences = 0;
  const latestPriorOccurrenceById = new Map<
    string,
    { readonly normalizedId: string; readonly remapped: boolean }
  >();
  const normalizedRows = rows.map((row, index) => {
    const remapped =
      duplicateEventIds.has(row.id) &&
      newestOccurrenceById.get(row.id) !== index;
    const normalizedId = remapped
      ? uuidv5(
          `${chatThreadId}:${row.seqId.toString()}:${row.id}`,
          DUPLICATE_EVENT_ID_NAMESPACE,
        )
      : row.id;
    if (remapped) {
      remappedEventIds += 1;
    }

    // References resolve to the latest preceding occurrence in logical event
    // order. Resolve before registering this row so a self-ID cannot redirect
    // a historical reference away from the preceding target.
    const referencedOccurrence =
      row.revokesEventId === null
        ? undefined
        : latestPriorOccurrenceById.get(row.revokesEventId);
    const normalizedRevokesEventId = referencedOccurrence?.remapped
      ? referencedOccurrence.normalizedId
      : row.revokesEventId;
    if (normalizedRevokesEventId !== row.revokesEventId) {
      remappedEventReferences += 1;
    }

    latestPriorOccurrenceById.set(row.id, { normalizedId, remapped });
    return {
      ...row,
      id: normalizedId,
      revokesEventId: normalizedRevokesEventId,
    };
  });
  return {
    body: Buffer.concat(normalizedRows.map(encodeArchiveLine)),
    normalization: {
      conflictingEventIds: duplicateEventIds.size,
      remappedEventIds,
      remappedEventReferences,
    },
  };
}
