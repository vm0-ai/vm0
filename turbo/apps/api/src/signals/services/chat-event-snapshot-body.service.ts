import {
  chatEventRowSchema,
  type ChatEventRow,
} from "@okouai/api-contracts/contracts/chat-event-rows";
import { chatEventFromRow } from "@okouai/api-contracts/contracts/chat-event-row-projection";

import { safeJsonParse } from "../utils";

const RETIRED_MORNING_BRIEF_CONTEXT = "morning_brief";
const RETIRED_MORNING_BRIEF_PART = "morning_brief";
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

interface MorningBriefSnapshotRepair {
  readonly body: Buffer;
  readonly rows: readonly ChatEventRow[];
  readonly repairedContextRows: number;
  readonly removedDocumentParts: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snapshotRawLines(body: Buffer): readonly string[] {
  const text = body.toString("utf8");
  if (text.length === 0) {
    return [];
  }
  if (!text.endsWith("\n")) {
    throw new Error("Chat Event snapshot must be newline-delimited JSON");
  }
  return text.slice(0, -1).split("\n");
}

function retiredMorningBriefPart(part: unknown): boolean {
  return isRecord(part) && part.type === RETIRED_MORNING_BRIEF_PART;
}

function assertExactRetiredMorningBriefPart(part: unknown): void {
  if (
    !isRecord(part) ||
    Object.keys(part).length !== 2 ||
    part.type !== RETIRED_MORNING_BRIEF_PART ||
    typeof part.briefDate !== "string" ||
    !ISO_DATE_PATTERN.test(part.briefDate)
  ) {
    throw new Error(
      "Chat Event snapshot has an unexpected retired Morning Brief part",
    );
  }
}

function isRepairableRetiredMorningBriefEvent(row: ChatEventRow): boolean {
  if (row.eventType === "input.prompt" || row.eventType === "input.rejected") {
    return true;
  }
  // The historical queue-discard path copied its target context onto this
  // payload-free tombstone. Keep the one-way exception exact to that shape.
  return (
    row.eventType === "control.revoke" &&
    row.runId === null &&
    row.revokesEventId !== null &&
    row.revokesEventId === row.contextId &&
    row.payload === null &&
    row.runEventSequenceNumber === null &&
    row.runEventId === null
  );
}

function repairMorningBriefRow(row: ChatEventRow): {
  readonly row: ChatEventRow;
  readonly removedDocumentParts: number;
} {
  const hasRetiredContext = row.contextType === RETIRED_MORNING_BRIEF_CONTEXT;
  const userMessage = row.payload?.userMessage;
  let legacyParts: readonly unknown[] = [];
  let parts: readonly unknown[] | undefined;

  if (hasRetiredContext && !isRepairableRetiredMorningBriefEvent(row)) {
    throw new Error(
      "Chat Event snapshot has an unexpected retired Morning Brief event",
    );
  }

  if (userMessage !== undefined) {
    if (!isRecord(userMessage) || !Array.isArray(userMessage.parts)) {
      if (hasRetiredContext) {
        throw new Error(
          "Chat Event snapshot has an unexpected retired Morning Brief document",
        );
      }
    } else {
      parts = userMessage.parts;
      legacyParts = parts.filter(retiredMorningBriefPart);
    }
  }

  if (!hasRetiredContext) {
    if (legacyParts.length > 0) {
      throw new Error(
        "Chat Event snapshot has an unscoped retired Morning Brief part",
      );
    }
    chatEventFromRow(row);
    return { row, removedDocumentParts: 0 };
  }
  if (row.contextId === null) {
    throw new Error(
      "Chat Event snapshot has an incomplete retired Morning Brief context",
    );
  }
  if (legacyParts.length > 1) {
    throw new Error(
      "Chat Event snapshot has duplicate retired Morning Brief parts",
    );
  }

  const removedDocumentParts = legacyParts.length;
  let payload = row.payload;
  if (removedDocumentParts === 1) {
    const retiredPart = legacyParts[0];
    assertExactRetiredMorningBriefPart(retiredPart);
    if (!isRecord(userMessage) || userMessage.version !== 1 || !parts) {
      throw new Error(
        "Chat Event snapshot has an unexpected retired Morning Brief document",
      );
    }
    const currentParts = parts.filter((part) => {
      return part !== retiredPart;
    });
    if (currentParts.length === 0) {
      throw new Error(
        "Chat Event snapshot Morning Brief repair would empty a message",
      );
    }
    payload = {
      ...row.payload,
      userMessage: { ...userMessage, parts: currentParts },
    };
  }

  const repaired = chatEventRowSchema.parse({
    ...row,
    contextType: "web",
    contextId: null,
    payload,
  });
  chatEventFromRow(repaired);
  return { row: repaired, removedDocumentParts };
}

export function decodeChatEventSnapshotBody(
  body: Buffer,
): readonly ChatEventRow[] {
  return snapshotRawLines(body).map((raw) => {
    const parsed = safeJsonParse(raw);
    if (parsed === undefined) {
      throw new Error("Chat Event snapshot contains invalid JSON");
    }
    return chatEventRowSchema.parse(parsed);
  });
}

/**
 * One-way Phase B archive repair. The retired shape is accepted only inside
 * snapshot publication, then every output row must project through the current
 * strict ChatEvent contract before its new immutable object can be published.
 */
export function repairMorningBriefPhaseBSnapshot(
  body: Buffer,
  decodedRows: readonly ChatEventRow[],
): MorningBriefSnapshotRepair {
  let repairedContextRows = 0;
  let removedDocumentParts = 0;
  let changed = false;
  const rawLines = snapshotRawLines(body);
  if (rawLines.length !== decodedRows.length) {
    throw new Error("Chat Event snapshot decoded row count changed");
  }
  const rows: ChatEventRow[] = [];
  const repairedLines = rawLines.map((raw, index) => {
    const row = decodedRows[index];
    if (row === undefined) {
      throw new Error("Chat Event snapshot decoded row is missing");
    }
    const repaired = repairMorningBriefRow(row);
    rows.push(repaired.row);
    if (repaired.row === row) {
      return Buffer.from(`${raw}\n`);
    }
    changed = true;
    repairedContextRows += 1;
    removedDocumentParts += repaired.removedDocumentParts;
    return Buffer.from(`${JSON.stringify(repaired.row)}\n`);
  });
  return {
    body: changed ? Buffer.concat(repairedLines) : body,
    rows,
    repairedContextRows,
    removedDocumentParts,
  };
}
