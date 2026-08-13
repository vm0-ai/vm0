import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";

import {
  decodeChatEventSnapshotBody,
  encodeChatEventSnapshotBody,
} from "./chat-event-row-downgrade.service";

/**
 * Every schema bump that can preserve historical data must register its
 * adjacent Snapshot upgrade here before the new version ships. V4 -> V5 is
 * intentionally absent because V4 discarded feedback location information.
 */
function adjacentSnapshotUpgrade(
  sourceVersion: number,
): ((rows: readonly ChatEventRow[]) => readonly ChatEventRow[]) | undefined {
  switch (sourceVersion) {
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
