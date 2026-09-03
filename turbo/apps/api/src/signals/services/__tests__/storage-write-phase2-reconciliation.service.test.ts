import { createHash } from "node:crypto";

import { MEMORY_ARTIFACT_NAME } from "@okouai/core/storage-names";
import { piMemoryPhase2Jobs } from "@okouai/db/schema/pi-memory-phase2-job";
import { storages } from "@okouai/db/schema/storage";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { db } from "../../../lib/db";
import { mockEnv } from "../../../lib/env";
import { readStorageIdentityFixture } from "../../../test-fixtures/storage";
import {
  createBddApi,
  type ApiTestUser,
} from "../../routes/__tests__/helpers/api-bdd";
import type { BddStorageFileEntry } from "../../routes/__tests__/helpers/api-bdd-storage-files";
import { createStoragesBddApi } from "../../routes/__tests__/helpers/api-bdd-storages";

const context = testContext();
const bdd = createBddApi(context);
const storageApi = createStoragesBddApi(context);

function requiredOrgId(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Storage reconciliation tests require an org actor");
  }
  return actor.orgId;
}

function declaredFile(path: string, content: string): BddStorageFileEntry {
  return {
    path,
    hash: createHash("sha256").update(content).digest("hex"),
    size: Buffer.byteLength(content),
  };
}

beforeEach(() => {
  mockEnv("R2_USER_STORAGES_BUCKET_NAME", "phase2-storage-write-test");
  storageApi.mockStoragePresignedUrls();
  storageApi.mockStorageObjectsExist();
});

describe("normal memory Storage publication", () => {
  it("requeues an existing Phase 2 job once per actual HEAD change in the commit transaction", async () => {
    const actor = bdd.user();
    const orgId = requiredOrgId(actor);
    const baseFiles = [declaredFile("memory_summary.md", "base memory")];
    const base = await storageApi.prepareStorage(actor, {
      storageName: MEMORY_ARTIFACT_NAME,
      storageOwner: "user",
      files: baseFiles,
    });
    await storageApi.commitStorage(actor, {
      storageName: MEMORY_ARTIFACT_NAME,
      storageOwner: "user",
      versionId: base.versionId,
      files: baseFiles,
    });
    const memory = await readStorageIdentityFixture({
      orgId,
      userId: actor.userId,
      name: MEMORY_ARTIFACT_NAME,
    });
    onTestFinished(async () => {
      await db()
        .update(storages)
        .set({ headVersionId: null })
        .where(eq(storages.id, memory.id));
      await db().delete(storages).where(eq(storages.id, memory.id));
    });
    await db().insert(piMemoryPhase2Jobs).values({
      memoryStorageId: memory.id,
      orgId,
      userId: actor.userId,
      status: "pending",
      inputRevision: 1,
      completedRevision: 0,
      retryCount: 0,
      lastObservedHeadVersionId: base.versionId,
    });

    const externalFiles = [
      declaredFile("memory_summary.md", "foreground memory"),
    ];
    const external = await storageApi.prepareStorage(actor, {
      storageName: MEMORY_ARTIFACT_NAME,
      storageOwner: "user",
      files: externalFiles,
    });
    await storageApi.commitStorage(actor, {
      storageName: MEMORY_ARTIFACT_NAME,
      storageOwner: "user",
      versionId: external.versionId,
      files: externalFiles,
    });

    await expect(
      db()
        .select()
        .from(piMemoryPhase2Jobs)
        .where(eq(piMemoryPhase2Jobs.memoryStorageId, memory.id)),
    ).resolves.toStrictEqual([
      expect.objectContaining({
        status: "pending",
        inputRevision: 2,
        completedRevision: 0,
        reconciliationRevision: 2,
        lastObservedHeadVersionId: external.versionId,
        retryCount: 0,
        retryAt: null,
        lastErrorClass: null,
      }),
    ]);

    await storageApi.commitStorage(actor, {
      storageName: MEMORY_ARTIFACT_NAME,
      storageOwner: "user",
      versionId: external.versionId,
      files: externalFiles,
    });
    await expect(
      db()
        .select({
          inputRevision: piMemoryPhase2Jobs.inputRevision,
          reconciliationRevision: piMemoryPhase2Jobs.reconciliationRevision,
          lastObservedHeadVersionId:
            piMemoryPhase2Jobs.lastObservedHeadVersionId,
        })
        .from(piMemoryPhase2Jobs)
        .where(eq(piMemoryPhase2Jobs.memoryStorageId, memory.id)),
    ).resolves.toStrictEqual([
      {
        inputRevision: 2,
        reconciliationRevision: 2,
        lastObservedHeadVersionId: external.versionId,
      },
    ]);
  });
});
