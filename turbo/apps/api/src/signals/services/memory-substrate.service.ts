import { createHash } from "node:crypto";

import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import {
  memorySources,
  type MemoryProvider,
  type MemorySourceMetadata,
  type MemorySourceType,
} from "@vm0/db/schema/memory-substrate";
import type { Db, ReadonlyDb } from "../external/db";
import { nowDate } from "../external/time";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";

interface MemoryScope {
  readonly orgId: string;
  readonly userId: string;
}

interface RecordMemorySourceArgs extends MemoryScope {
  readonly provider: MemoryProvider;
  readonly sourceType: MemorySourceType;
  readonly externalId: string;
  readonly connectorId?: string | null;
  readonly occurredAt?: Date | null;
  readonly title?: string | null;
  readonly contentHash?: string | null;
  readonly metadata: MemorySourceMetadata;
}

export function memoryContentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function memorySubstrateEnabled(
  db: ReadonlyDb,
  scope: MemoryScope,
): Promise<boolean> {
  const context = await loadUserFeatureSwitchContext(
    db,
    scope.orgId,
    scope.userId,
  );
  return isFeatureEnabled(FeatureSwitchKey.RelationshipMemory, context);
}

export async function recordMemorySource(
  db: Db,
  args: RecordMemorySourceArgs,
): Promise<boolean> {
  if (!(await memorySubstrateEnabled(db, args))) {
    return false;
  }

  const currentTime = nowDate();
  const values: typeof memorySources.$inferInsert = {
    orgId: args.orgId,
    userId: args.userId,
    provider: args.provider,
    sourceType: args.sourceType,
    externalId: args.externalId,
    connectorId: args.connectorId ?? null,
    occurredAt: args.occurredAt ?? null,
    title: args.title ?? null,
    contentHash: args.contentHash ?? null,
    metadata: args.metadata,
    createdAt: currentTime,
    updatedAt: currentTime,
  };

  await db
    .insert(memorySources)
    .values(values)
    .onConflictDoUpdate({
      target: [
        memorySources.orgId,
        memorySources.userId,
        memorySources.provider,
        memorySources.externalId,
      ],
      set: {
        sourceType: values.sourceType,
        connectorId: values.connectorId,
        occurredAt: values.occurredAt,
        title: values.title,
        contentHash: values.contentHash,
        metadata: values.metadata,
        updatedAt: currentTime,
      },
    });

  return true;
}
