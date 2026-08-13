import { command, createStore } from "ccstate";
import {
  getPresentationTemplateStorageName,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import { presentationTemplates } from "@okouai/db/schema/presentation-template";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { and, eq, sql } from "drizzle-orm";

import { env } from "../../lib/env";
import type { Tx } from "../../lib/db-types";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { deleteS3Objects, listS3ObjectsUnderPrefix } from "../external/s3";
import { onRejection, settle } from "../utils";
import {
  commitPreparedVolumeServerSide,
  prepareVolumeServerSide$,
} from "./storage-volume-publication.service";

const L = logger("PresentationTemplatePackage");
const CLEANUP_TIMEOUT_MS = 30_000;

export async function lockPresentationTemplateLifecycle(
  db: Tx,
  templateId: string,
): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`presentation_template:${templateId}`}, 0))`,
  );
}

export const cleanupPresentationTemplatePackage$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly templateId: string;
      readonly preparedVersionPrefix?: string;
      readonly force?: boolean;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    await db.transaction(async (tx) => {
      await lockPresentationTemplateLifecycle(tx, args.templateId);
      signal.throwIfAborted();
      const [template] = await tx
        .select({ status: presentationTemplates.status })
        .from(presentationTemplates)
        .where(
          and(
            eq(presentationTemplates.id, args.templateId),
            eq(presentationTemplates.orgId, args.orgId),
          ),
        )
        .limit(1);

      const [storage] = await tx
        .select({
          id: storages.id,
          s3Prefix: storages.s3Prefix,
          headVersionId: storages.headVersionId,
        })
        .from(storages)
        .where(
          and(
            eq(storages.orgId, args.orgId),
            eq(storages.userId, VOLUME_ORG_USER_ID),
            eq(
              storages.name,
              getPresentationTemplateStorageName(args.templateId),
            ),
          ),
        )
        .limit(1);

      const prefixes = new Set<string>();
      const retainReadyStorage = template?.status === "ready" && !args.force;
      if (retainReadyStorage) {
        const [headVersion] = storage?.headVersionId
          ? await tx
              .select({ s3Key: storageVersions.s3Key })
              .from(storageVersions)
              .where(
                and(
                  eq(storageVersions.id, storage.headVersionId),
                  eq(storageVersions.storageId, storage.id),
                ),
              )
              .limit(1)
          : [];
        if (
          args.preparedVersionPrefix &&
          headVersion &&
          args.preparedVersionPrefix !== headVersion.s3Key
        ) {
          prefixes.add(args.preparedVersionPrefix);
        }
      } else {
        if (storage) {
          prefixes.add(storage.s3Prefix);
        }
        if (args.preparedVersionPrefix) {
          prefixes.add(args.preparedVersionPrefix);
        }
      }
      const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
      for (const prefix of prefixes) {
        const objects = await get(listS3ObjectsUnderPrefix(bucket, prefix));
        signal.throwIfAborted();
        await get(
          deleteS3Objects(
            bucket,
            objects.map((object) => {
              return object.key;
            }),
          ),
        );
        signal.throwIfAborted();
      }
      if (storage && !retainReadyStorage) {
        await tx.delete(storages).where(eq(storages.id, storage.id));
      }
    });
    signal.throwIfAborted();
  },
);

async function cleanupAfterPublicationFailure(args: {
  readonly orgId: string;
  readonly templateId: string;
  readonly preparedVersionPrefix?: string;
}): Promise<void> {
  const store = createStore();
  await store.set(
    cleanupPresentationTemplatePackage$,
    args,
    AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
  );
}

async function cleanupAfterPublicationFailureAndLog(args: {
  readonly orgId: string;
  readonly templateId: string;
  readonly preparedVersionPrefix?: string;
}): Promise<void> {
  const cleanup = await settle(cleanupAfterPublicationFailure(args));
  if (!cleanup.ok) {
    L.error("Failed to clean an unpublished template package", {
      templateId: args.templateId,
      error: cleanup.error,
    });
  }
}

export const publishPresentationTemplatePackage$ = command(
  (
    { set },
    args: {
      readonly orgId: string;
      readonly ownerUserId: string;
      readonly templateId: string;
      readonly files: readonly {
        readonly path: string;
        readonly content: string;
      }[];
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    let preparedVersionPrefix: string | undefined;
    const publish = async (): Promise<boolean> => {
      const db = set(writeDb$);
      const published = await db.transaction(async (tx) => {
        await lockPresentationTemplateLifecycle(tx, args.templateId);
        signal.throwIfAborted();
        const [active] = await tx
          .select({ id: presentationTemplates.id })
          .from(presentationTemplates)
          .where(
            and(
              eq(presentationTemplates.id, args.templateId),
              eq(presentationTemplates.orgId, args.orgId),
              eq(presentationTemplates.ownerUserId, args.ownerUserId),
              eq(presentationTemplates.status, "processing"),
            ),
          )
          .limit(1);
        signal.throwIfAborted();
        if (!active) {
          return false;
        }
        const volume = await set(
          prepareVolumeServerSide$,
          {
            orgId: args.orgId,
            storageName: getPresentationTemplateStorageName(args.templateId),
            files: args.files,
          },
          signal,
        );
        preparedVersionPrefix = volume.version.s3Key;
        signal.throwIfAborted();
        const [updated] = await tx
          .update(presentationTemplates)
          .set({
            status: "ready",
            error: null,
            updatedAt: nowDate(),
            updatedBy: args.ownerUserId,
          })
          .where(
            and(
              eq(presentationTemplates.id, args.templateId),
              eq(presentationTemplates.orgId, args.orgId),
              eq(presentationTemplates.ownerUserId, args.ownerUserId),
              eq(presentationTemplates.status, "processing"),
            ),
          )
          .returning({ id: presentationTemplates.id });
        if (!updated) {
          return false;
        }
        await commitPreparedVolumeServerSide({ db: tx, volume }, signal);
        return true;
      });
      signal.throwIfAborted();
      if (!published) {
        await cleanupAfterPublicationFailure({
          orgId: args.orgId,
          templateId: args.templateId,
          preparedVersionPrefix,
        });
        signal.throwIfAborted();
      }
      return published;
    };
    return onRejection(publish(), () => {
      return cleanupAfterPublicationFailureAndLog({
        orgId: args.orgId,
        templateId: args.templateId,
        preparedVersionPrefix,
      });
    });
  },
);
