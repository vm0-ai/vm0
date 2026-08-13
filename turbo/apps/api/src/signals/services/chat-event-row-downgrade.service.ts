import {
  chatEventRowSchema,
  type ChatEventRow,
} from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  type UserMessageDocument,
  userMessageDocumentSchema,
} from "@okouai/api-contracts/contracts/chat-threads";

import { safeJsonParse } from "../utils";

function projectV4UserMessage(
  document: UserMessageDocument,
): UserMessageDocument {
  return {
    ...document,
    parts: document.parts.map((part) => {
      if (part.type !== "feedback") {
        return part;
      }
      const projected = { ...part };
      delete projected.eventId;
      delete projected.range;
      return projected;
    }),
  };
}

function downgradeV5RowToV4(row: ChatEventRow): ChatEventRow {
  const userMessage = row.payload?.userMessage;
  if (userMessage === undefined) {
    return row;
  }
  const parsed = userMessageDocumentSchema.safeParse(userMessage);
  if (!parsed.success) {
    return row;
  }
  return {
    ...row,
    payload: {
      ...row.payload,
      userMessage: projectV4UserMessage(parsed.data),
    },
  };
}

/** Apply every adjacent row downgrade until the requested version is reached. */
export function downgradeChatEventRow(
  row: ChatEventRow,
  sourceVersion: number,
  requestedVersion: number,
): ChatEventRow {
  if (requestedVersion > sourceVersion) {
    throw new Error("Chat Event row downgrade target is newer than its source");
  }
  let version = sourceVersion;
  let projected = row;
  while (version > requestedVersion) {
    switch (version) {
      case 5: {
        projected = downgradeV5RowToV4(projected);
        version = 4;
        break;
      }
      default: {
        throw new Error(
          `Missing Chat Event row downgrade from V${version.toString()}`,
        );
      }
    }
  }
  return projected;
}

export function decodeChatEventSnapshotBody(
  body: Buffer,
): readonly ChatEventRow[] {
  const text = body.toString("utf8");
  if (text.length === 0 || !text.endsWith("\n")) {
    throw new Error("Chat Event snapshot must be newline-delimited JSON");
  }
  return text
    .slice(0, -1)
    .split("\n")
    .map((line) => {
      const parsed = safeJsonParse(line);
      if (parsed === undefined) {
        throw new Error("Chat Event snapshot contains invalid JSON");
      }
      return parsed;
    })
    .map((row) => {
      return chatEventRowSchema.parse(row);
    });
}

export function encodeChatEventSnapshotBody(
  rows: readonly ChatEventRow[],
): Buffer {
  return Buffer.from(
    rows
      .map((row) => {
        return JSON.stringify(row);
      })
      .join("\n") + "\n",
  );
}

export function downgradeChatEventSnapshotBody(
  body: Buffer,
  sourceVersion: number,
  requestedVersion: number,
): Buffer {
  return encodeChatEventSnapshotBody(
    decodeChatEventSnapshotBody(body).map((row) => {
      return downgradeChatEventRow(row, sourceVersion, requestedVersion);
    }),
  );
}
