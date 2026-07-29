import { createHash } from "node:crypto";

import { MEMORY_ARTIFACT_NAME } from "@vm0/core/storage-names";

import type { TestContext } from "../../../../__tests__/test-context";
import { readStorageS3PrefixFixture } from "../../../../test-fixtures/storage";
import type { ApiTestUser } from "./api-bdd";
import { createStoragesBddApi } from "./api-bdd-storages";

interface MemoryFile {
  readonly path: string;
  readonly content: string;
}

interface CommittedMemoryVersion {
  readonly versionId: string;
  readonly s3Key: string;
}

/**
 * Create (or dedupe onto) a memory artifact version through the in-process
 * Storage fixture. Returns the content-addressed version id and the S3 key
 * assigned to it.
 */
export async function commitMemoryVersion(
  context: TestContext,
  actor: ApiTestUser,
  files: readonly MemoryFile[],
): Promise<CommittedMemoryVersion> {
  if (!actor.orgId) {
    throw new Error("commitMemoryVersion requires an actor with an org");
  }
  const storagesApi = createStoragesBddApi(context);
  const entries = files.map((file) => {
    const content = Buffer.from(file.content, "utf8");
    return {
      path: file.path,
      hash: createHash("sha256").update(content).digest("hex"),
      size: content.length,
    };
  });

  const prepared = await storagesApi.prepareStorage(actor, {
    storageName: MEMORY_ARTIFACT_NAME,
    storageOwner: "user",
    files: entries,
  });
  storagesApi.mockStorageObjectExistsOnce();
  storagesApi.mockStorageObjectExistsOnce();
  await storagesApi.commitStorage(actor, {
    storageName: MEMORY_ARTIFACT_NAME,
    storageOwner: "user",
    versionId: prepared.versionId,
    files: entries,
  });

  const s3Prefix = await readStorageS3PrefixFixture({
    orgId: actor.orgId,
    userId: actor.userId,
    name: MEMORY_ARTIFACT_NAME,
  });
  return {
    versionId: prepared.versionId,
    s3Key: `${s3Prefix}/${prepared.versionId}`,
  };
}
