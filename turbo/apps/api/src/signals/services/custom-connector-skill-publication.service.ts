import {
  getCustomConnectorSkillStorageName,
  VOLUME_ORG_USER_ID,
} from "@vm0/core/storage-names";
import {
  customConnectorSkillPublications,
  deletedCustomConnectorSkillStorages,
} from "@vm0/db/schema/custom-connector-skill-cleanup";
import { storages } from "@vm0/db/schema/storage";
import { and, eq } from "drizzle-orm";

import type { Db } from "../external/db";
import type { PreparedServerSideVolume } from "./storage-volume-publication.service";

export async function establishCustomConnectorSkillPublication(
  args: {
    readonly db: Db;
    readonly volume: PreparedServerSideVolume;
    readonly stateUpdatedAt: Date;
  },
  signal: AbortSignal,
): Promise<void> {
  const [publication] = await args.db
    .insert(customConnectorSkillPublications)
    .values({
      versionId: args.volume.version.versionId,
      storageId: args.volume.version.storageId,
      s3Prefix: args.volume.s3Prefix,
      state: "preparing",
      stateUpdatedAt: args.stateUpdatedAt,
    })
    .onConflictDoUpdate({
      target: customConnectorSkillPublications.versionId,
      set: { stateUpdatedAt: args.stateUpdatedAt },
      setWhere: and(
        eq(
          customConnectorSkillPublications.storageId,
          args.volume.version.storageId,
        ),
        eq(customConnectorSkillPublications.s3Prefix, args.volume.s3Prefix),
        eq(customConnectorSkillPublications.state, "preparing"),
      ),
    })
    .returning({ versionId: customConnectorSkillPublications.versionId });
  signal.throwIfAborted();
  if (!publication) {
    throw new Error(
      `Custom connector skill publication ${args.volume.version.versionId} is claimed for cleanup`,
    );
  }
}

export async function retireCustomConnectorSkillPublication(
  args: {
    readonly db: Db;
    readonly volume: PreparedServerSideVolume;
    readonly required: boolean;
  },
  signal: AbortSignal,
): Promise<void> {
  const [publication] = await args.db
    .delete(customConnectorSkillPublications)
    .where(
      and(
        eq(
          customConnectorSkillPublications.versionId,
          args.volume.version.versionId,
        ),
        eq(
          customConnectorSkillPublications.storageId,
          args.volume.version.storageId,
        ),
        eq(customConnectorSkillPublications.s3Prefix, args.volume.s3Prefix),
        eq(customConnectorSkillPublications.state, "preparing"),
      ),
    )
    .returning({ versionId: customConnectorSkillPublications.versionId });
  signal.throwIfAborted();
  if (args.required && !publication) {
    throw new Error(
      `Custom connector skill publication ${args.volume.version.versionId} changed before activation`,
    );
  }
}

export async function recordDeletedCustomConnectorSkillStorage(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly connectorId: string;
    readonly deletedAt: Date;
  },
  signal: AbortSignal,
): Promise<void> {
  const [storage] = await args.db
    .select({ id: storages.id, s3Prefix: storages.s3Prefix })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, args.orgId),
        eq(storages.userId, VOLUME_ORG_USER_ID),
        eq(storages.name, getCustomConnectorSkillStorageName(args.connectorId)),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!storage) {
    return;
  }

  await args.db
    .insert(deletedCustomConnectorSkillStorages)
    .values({
      storageId: storage.id,
      connectorId: args.connectorId,
      s3Prefix: storage.s3Prefix,
      deletedAt: args.deletedAt,
    })
    .onConflictDoNothing();
  signal.throwIfAborted();
}
