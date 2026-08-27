import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";

import {
  decodeChatEventSnapshotBody,
  encodeChatEventSnapshotBody,
} from "./chat-event-snapshot-body.service";

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
      // V7 makes the already-redacted logical history canonical. A legacy
      // full prefix is accepted only as an upgrade source and loses tool rows.
      return (rows) => {
        return rows.filter((row) => {
          return row.eventType !== "output.tool";
        });
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
  let rows = decodeChatEventSnapshotBody(body);
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
