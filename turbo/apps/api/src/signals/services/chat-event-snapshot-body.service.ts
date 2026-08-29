import {
  chatEventRowSchema,
  type ChatEventRow,
} from "@okouai/api-contracts/contracts/chat-event-rows";

import { safeJsonParse } from "../utils";

export function decodeChatEventSnapshotBody(
  body: Buffer,
): readonly ChatEventRow[] {
  const text = body.toString("utf8");
  if (text.length === 0) {
    return [];
  }
  if (!text.endsWith("\n")) {
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
  if (rows.length === 0) {
    return Buffer.alloc(0);
  }
  return Buffer.from(
    rows
      .map((row) => {
        return JSON.stringify(row);
      })
      .join("\n") + "\n",
  );
}
