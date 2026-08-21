import { createHash } from "node:crypto";

import {
  getInstructionsStorageName,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { and, eq, isNull } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import { newStorageS3Location } from "../services/storage-s3-prefix.utils";

/**
 * Seeds the empty instructions storage created by the product Agent API.
 *
 * Test-only integration seed routes construct their Agent rows directly, so
 * they must also construct this application-owned launch dependency instead
 * of relying on legacy Compose content that omitted the instructions mount.
 */
export async function ensureAgentInstructionsStorageFixture(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentName: string;
  },
  signal: AbortSignal,
): Promise<void> {
  const storageName = getInstructionsStorageName(args.agentName.toLowerCase());
  const location = newStorageS3Location(args.orgId);
  const [storage] = await db
    .insert(storages)
    .values({
      id: location.storageId,
      orgId: args.orgId,
      userId: VOLUME_ORG_USER_ID,
      name: storageName,
      s3Prefix: location.s3Prefix,
      size: 0,
      fileCount: 0,
    })
    .onConflictDoUpdate({
      target: [storages.orgId, storages.userId, storages.name],
      set: { updatedAt: nowDate() },
    })
    .returning({
      id: storages.id,
      headVersionId: storages.headVersionId,
      s3Prefix: storages.s3Prefix,
    });
  signal.throwIfAborted();
  if (!storage) {
    throw new Error("Failed to seed Agent instructions storage fixture");
  }
  if (storage.headVersionId) {
    return;
  }

  const versionId = createHash("sha256")
    .update(`test-agent-instructions:${storage.id}`)
    .digest("hex");
  await db
    .insert(storageVersions)
    .values({
      id: versionId,
      storageId: storage.id,
      s3Key: `${storage.s3Prefix}/${versionId}`,
      size: 0,
      archiveSize: 0,
      fileCount: 0,
      message: "Seeded Agent instructions fixture",
      createdBy: args.userId,
    })
    .onConflictDoNothing();
  signal.throwIfAborted();

  await db
    .update(storages)
    .set({
      headVersionId: versionId,
      size: 0,
      fileCount: 0,
      updatedAt: nowDate(),
    })
    .where(and(eq(storages.id, storage.id), isNull(storages.headVersionId)));
  signal.throwIfAborted();
}
