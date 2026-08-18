import { command, createStore } from "ccstate";
import {
  MAX_PRESENTATION_TEMPLATE_PACKAGE_ARCHIVE_BYTES,
  PRESENTATION_TEMPLATE_PACKAGE_CONTENT_TYPE,
} from "@okouai/api-contracts/contracts/zero-presentation-templates";
import {
  getPresentationTemplateStorageName,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import { presentationTemplates } from "@okouai/db/schema/presentation-template";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { and, eq } from "drizzle-orm";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  deleteS3Objects,
  downloadS3BufferWithMaxBytes,
  listS3ObjectsUnderPrefix,
} from "../external/s3";
import { onRejection, settle } from "../utils";
import { resolveArtifactObject$ } from "./artifact-storage.service";
import { lockPresentationTemplateLifecycle } from "./presentation-template-lifecycle.service";
import {
  validatePresentationTemplatePackageArchive,
  type PresentationTemplatePackageFile,
} from "./presentation-template-package-archive.service";
import {
  commitPreparedVolumeServerSide,
  prepareVolumeServerSide$,
} from "./storage-volume-publication.service";

const L = logger("PresentationTemplatePackage");
const CLEANUP_TIMEOUT_MS = 30_000;

type CommitPresentationTemplatePackageResult =
  | { readonly kind: "published" }
  | { readonly kind: "conflict" }
  | { readonly kind: "invalid-upload"; readonly message: string };

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

const publishPresentationTemplatePackageFiles$ = command(
  (
    { set },
    args: {
      readonly orgId: string;
      readonly ownerUserId: string;
      readonly templateId: string;
      readonly files: readonly PresentationTemplatePackageFile[];
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

async function cleanupUploadedArchive(
  key: string,
  cleanup: () => Promise<void>,
): Promise<void> {
  const result = await settle(cleanup());
  if (!result.ok) {
    L.error("Failed to clean an uploaded template package archive", {
      key,
      error: result.error,
    });
  }
}

export const commitPresentationTemplatePackage$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly ownerUserId: string;
      readonly templateId: string;
      readonly archiveFileId: string;
    },
    signal: AbortSignal,
  ): Promise<CommitPresentationTemplatePackageResult> => {
    const uploaded = await set(
      resolveArtifactObject$,
      { userId: args.ownerUserId, id: args.archiveFileId },
      signal,
    );
    if (!uploaded) {
      return {
        kind: "invalid-upload",
        message: "The template package archive upload was not found",
      };
    }

    const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
    const cleanup = async (): Promise<void> => {
      await get(deleteS3Objects(bucket, [uploaded.key]));
    };
    const commit =
      async (): Promise<CommitPresentationTemplatePackageResult> => {
        if (
          uploaded.contentType !== PRESENTATION_TEMPLATE_PACKAGE_CONTENT_TYPE ||
          !uploaded.filename.toLowerCase().endsWith(".tar.gz")
        ) {
          return {
            kind: "invalid-upload",
            message: "Template packages must be uploaded as a tar.gz archive",
          };
        }
        if (
          uploaded.size <= 0 ||
          uploaded.size > MAX_PRESENTATION_TEMPLATE_PACKAGE_ARCHIVE_BYTES
        ) {
          return {
            kind: "invalid-upload",
            message: `Template package archives must be non-empty and no larger than ${MAX_PRESENTATION_TEMPLATE_PACKAGE_ARCHIVE_BYTES.toString()} bytes`,
          };
        }

        const archive = await get(
          downloadS3BufferWithMaxBytes(
            bucket,
            uploaded.key,
            MAX_PRESENTATION_TEMPLATE_PACKAGE_ARCHIVE_BYTES,
            signal,
          ),
        );
        signal.throwIfAborted();
        const validated = await validatePresentationTemplatePackageArchive(
          archive,
          signal,
        );
        if (!validated.ok) {
          return { kind: "invalid-upload", message: validated.message };
        }
        const published = await set(
          publishPresentationTemplatePackageFiles$,
          {
            orgId: args.orgId,
            ownerUserId: args.ownerUserId,
            templateId: args.templateId,
            files: validated.files,
          },
          signal,
        );
        return published ? { kind: "published" } : { kind: "conflict" };
      };

    const result = await onRejection(commit(), () => {
      return cleanupUploadedArchive(uploaded.key, cleanup);
    });
    signal.throwIfAborted();
    await cleanupUploadedArchive(uploaded.key, cleanup);
    signal.throwIfAborted();
    return result;
  },
);
