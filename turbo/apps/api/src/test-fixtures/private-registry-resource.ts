import { randomUUID } from "node:crypto";

import { storages, storageVersions } from "@vm0/db/schema/storage";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { writeDb$ } from "../signals/external/db";
import { storageDml } from "../signals/services/storage-dml.service";

interface PrivateRegistryResourceVersionFixture {
  readonly cleanup: () => Promise<void>;
}

/**
 * Seed one production-pinned private registry version.
 *
 * This is intentionally a narrow external-boundary exception: production
 * storage APIs derive version ids from a server-generated storage UUID, while
 * the registry route must look up the exact version id created by the manual
 * infrastructure upload. A caller cannot recreate that pinned id through the
 * production API surface.
 */
export async function seedPrivateRegistryResourceVersionFixture(args: {
  readonly storageName: string;
  readonly versionId: string;
  readonly s3Key: string;
  readonly size: number;
  readonly archiveSize: number;
  readonly fileCount: number;
}): Promise<PrivateRegistryResourceVersionFixture> {
  const db = createStore().set(writeDb$);
  const fixtureId = randomUUID();
  const [storage] = await db
    .insert(storageDml)
    .values({
      orgId: `org_registry_fixture_${fixtureId}`,
      userId: `user_registry_fixture_${fixtureId}`,
      name: args.storageName,
      s3Prefix: `registry-fixture/${fixtureId}`,
      size: args.size,
      fileCount: args.fileCount,
    })
    .returning({ id: storageDml.id });
  if (!storage) {
    throw new Error("Failed to seed private registry resource storage");
  }

  await db.insert(storageVersions).values({
    id: args.versionId,
    storageId: storage.id,
    s3Key: args.s3Key,
    size: args.size,
    archiveSize: args.archiveSize,
    fileCount: args.fileCount,
    message: "Seeded for private registry resource route coverage",
    createdBy: "private-registry-resource-fixture",
  });

  return {
    cleanup: async () => {
      await db
        .delete(storageVersions)
        .where(
          and(
            eq(storageVersions.id, args.versionId),
            eq(storageVersions.storageId, storage.id),
          ),
        );
      await db.delete(storages).where(eq(storages.id, storage.id));
    },
  };
}
