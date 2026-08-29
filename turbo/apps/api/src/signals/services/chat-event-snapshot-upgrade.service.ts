import {
  chatEventRowSchema,
  type ChatEventRow,
} from "@okouai/api-contracts/contracts/chat-event-rows";
import { z } from "zod";

import {
  decodeChatEventSnapshotBody,
  encodeChatEventSnapshotBody,
} from "./chat-event-snapshot-body.service";
import { safeJsonParse } from "../utils";

/**
 * Private R2-only reader for immutable V6 objects retained behind #29362.
 * `output.tool` is deliberately absent from every current API/DB contract;
 * this schema exists only so an old full Snapshot can be validated and
 * upgraded without discarding the surrounding logical history.
 */
const legacyV6OutputToolRowSchema = z
  .object({
    id: z.string(),
    chatThreadId: z.string(),
    runId: z.string().nullable(),
    revokesEventId: z.string().nullable(),
    contextType: z.string().nullable(),
    contextId: z.string().nullable(),
    runEventSequenceNumber: z.number().int().nullable(),
    runEventId: z.string().nullable(),
    seqId: z.number().int(),
    createdAt: z.iso.datetime(),
    eventType: z.literal("output.tool"),
    payload: z
      .object({
        toolUseId: z.string(),
        action: z.enum(["run", "read", "write", "edit"]),
        status: z.enum(["pending", "success", "error", "cancelled"]),
        summary: z
          .string()
          .max(240)
          .refine((summary) => {
            return !summary.includes("\n") && !summary.includes("\r");
          }, "Tool summary must be one line"),
      })
      .strict(),
  })
  .strict();

type StoredChatEventSnapshotRow =
  | ChatEventRow
  | z.infer<typeof legacyV6OutputToolRowSchema>;

function decodeStoredChatEventSnapshotBody(
  body: Buffer,
  sourceVersion: number,
): readonly StoredChatEventSnapshotRow[] {
  if (sourceVersion !== 6) {
    return decodeChatEventSnapshotBody(body);
  }
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
      const legacyTool = legacyV6OutputToolRowSchema.safeParse(row);
      return legacyTool.success
        ? legacyTool.data
        : chatEventRowSchema.parse(row);
    });
}

export function lastStoredChatEventSnapshotRowId(
  body: Buffer,
  sourceVersion: number,
): string | null {
  return (
    decodeStoredChatEventSnapshotBody(body, sourceVersion).at(-1)?.id ?? null
  );
}

/**
 * Every schema bump that can preserve historical data must register its
 * adjacent Snapshot upgrade here before the new version ships.
 */
function adjacentSnapshotUpgrade(
  sourceVersion: number,
): ((rows: readonly ChatEventRow[]) => readonly ChatEventRow[]) | undefined {
  switch (sourceVersion) {
    case 5: {
      // Persisted V5 DB/R2 -> V7 API fallback through V6: V6 only added
      // output.tool, so every V5 row remains valid. Remove with #29362 after
      // V7 convergence and reference-aware GC remove retired V5/V6 state.
      return (rows) => {
        return rows;
      };
    }
    case 6: {
      // The private V6 decoder already removed validated legacy tool rows.
      // Keep this adjacent identity step until #29362 permits deleting V6 R2
      // readers and reference-aware GC has retired every referenced object.
      return (rows) => {
        return rows;
      };
    }
    default: {
      return undefined;
    }
  }
}

/** Upgrade only the stored prefix; callers append Raw Events after its cursor. */
export function upgradeChatEventSnapshotBody(
  body: Buffer,
  sourceVersion: number,
  requestedVersion: number,
): Buffer {
  if (requestedVersion < sourceVersion) {
    throw new Error(
      "Chat Event Snapshot upgrade target is older than its source",
    );
  }
  let rows: readonly ChatEventRow[] = decodeStoredChatEventSnapshotBody(
    body,
    sourceVersion,
  ).flatMap((row): readonly ChatEventRow[] => {
    return row.eventType === "output.tool" ? [] : [row];
  });
  let version = sourceVersion;
  while (version < requestedVersion) {
    const upgrade = adjacentSnapshotUpgrade(version);
    if (upgrade === undefined) {
      throw new Error(
        `Missing Chat Event Snapshot upgrade from V${version.toString()} to V${(version + 1).toString()}`,
      );
    }
    rows = upgrade(rows);
    version += 1;
  }
  return sourceVersion === requestedVersion
    ? body
    : encodeChatEventSnapshotBody(rows);
}
