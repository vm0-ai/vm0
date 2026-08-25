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
      // V6 adds output.tool; every valid V5 row remains valid unchanged.
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
