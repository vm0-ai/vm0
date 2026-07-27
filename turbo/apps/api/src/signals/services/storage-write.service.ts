import { MAX_FILE_SIZE_BYTES } from "@vm0/api-contracts/contracts/storages";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { storageVersionLineage } from "@vm0/db/schema/storage-version-lineage";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { command, computed, type Computed } from "ccstate";
import { and, eq } from "drizzle-orm";

import { badRequestMessage, notFound } from "../../lib/error";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import type { AuthContext } from "../../types/auth";
import { writeDb$, type Db } from "../external/db";
import {
  downloadManifest,
  generatePresignedPutUrl,
  s3ObjectExists,
  s3ObjectHead,
  type S3ObjectHead,
  verifyS3FilesExist,
} from "../external/s3";
import { tapError } from "../utils";
import {
  computeContentHashFromHashes,
  type FileEntryWithHash,
} from "./storage-content-hash.service";

const L = logger("storage-write");

interface StorageChanges {
  readonly deleted?: readonly string[];
}

interface PrepareStorageUploadInput {
  readonly files: readonly FileEntryWithHash[];
  readonly force?: boolean;
  readonly runId?: string;
  readonly baseVersion?: string;
  readonly changes?: StorageChanges;
}

interface PrepareStorageInput extends PrepareStorageUploadInput {
  readonly auth: AuthContext;
  readonly storageId: string;
}

interface PrepareStorageForStorageInput extends PrepareStorageUploadInput {
  readonly storageId: string;
}

interface CommitStorageUploadInput {
  readonly versionId: string;
  readonly files: readonly FileEntryWithHash[];
  readonly runId?: string;
  readonly parentVersionId?: string;
  readonly message?: string;
}

interface CommitStorageInput extends CommitStorageUploadInput {
  readonly auth: AuthContext;
  readonly storageId: string;
}

interface CommitStorageForStorageInput extends CommitStorageUploadInput {
  readonly storageId: string;
}

type StorageRow = typeof storages.$inferSelect;
type StorageVersionRow = typeof storageVersions.$inferSelect;

function storageRowSelection() {
  return {
    id: storages.id,
    userId: storages.userId,
    name: storages.name,
    orgId: storages.orgId,
    s3Prefix: storages.s3Prefix,
    size: storages.size,
    fileCount: storages.fileCount,
    headVersionId: storages.headVersionId,
    createdAt: storages.createdAt,
    updatedAt: storages.updatedAt,
  };
}

type StorageErrorResponse =
  | ReturnType<typeof badRequestMessage>
  | ReturnType<typeof notFound>
  | {
      readonly status: 413;
      readonly body: {
        readonly error: {
          readonly message: string;
          readonly code: "PAYLOAD_TOO_LARGE";
        };
      };
    }
  | {
      readonly status: 500;
      readonly body: {
        readonly error: {
          readonly message: string;
          readonly code: "INTERNAL_ERROR";
        };
      };
    };

type PrepareStorageResponse =
  | {
      readonly status: 200;
      readonly body: {
        readonly versionId: string;
        readonly existing: boolean;
        readonly uploads?: {
          readonly archive: {
            readonly key: string;
            readonly presignedUrl: string;
          };
          readonly manifest: {
            readonly key: string;
            readonly presignedUrl: string;
          };
        };
      };
    }
  | StorageErrorResponse;

type CommitStorageResponse =
  | {
      readonly status: 200;
      readonly body: {
        readonly success: true;
        readonly versionId: string;
        readonly storageName: string;
        readonly size: number;
        readonly fileCount: number;
        readonly deduplicated?: boolean;
      };
    }
  | StorageErrorResponse
  | {
      readonly status: 409;
      readonly body: {
        readonly error: {
          readonly message: string;
          readonly code: "S3_FILES_MISSING";
        };
      };
    };

function payloadTooLarge(message: string): StorageErrorResponse {
  return {
    status: 413,
    body: { error: { message, code: "PAYLOAD_TOO_LARGE" } },
  };
}

function internalError(message: string): StorageErrorResponse {
  return {
    status: 500,
    body: { error: { message, code: "INTERNAL_ERROR" } },
  };
}

function storageServiceNotConfigured(): StorageErrorResponse {
  return internalError("Storage service is not properly configured");
}

async function findMountedWritebackStorage(args: {
  readonly db: Db;
  readonly auth: AuthContext;
  readonly storageId: string;
  readonly signal: AbortSignal;
}): Promise<StorageRow | StorageErrorResponse> {
  if (!hasRunId(args.auth)) {
    return notFound("Writeback storage not found");
  }

  const [run] = await args.db
    .select({ storageMounts: agentRuns.storageMounts })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, args.auth.runId),
        eq(agentRuns.userId, args.auth.userId),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();

  if (!run) {
    return notFound("Agent run not found");
  }

  const mount = run.storageMounts?.find((entry) => {
    return entry.storageId === args.storageId && entry.writeback === true;
  });
  if (!mount) {
    return notFound("Writeback storage not found");
  }

  const [storage] = await args.db
    .select(storageRowSelection())
    .from(storages)
    .where(
      and(
        eq(storages.id, mount.storageId),
        eq(storages.orgId, mount.orgId),
        eq(storages.userId, mount.userId),
        eq(storages.name, mount.name),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();

  return storage ?? notFound("Writeback storage not found");
}

function hasRunId(auth: AuthContext): auth is AuthContext & {
  readonly runId: string;
} {
  return "runId" in auth && typeof auth.runId === "string";
}

function mergeWithBaseVersion(args: {
  readonly db: Db;
  readonly bucket: string;
  readonly storageId: string;
  readonly files: readonly FileEntryWithHash[];
  readonly baseVersion: string;
  readonly changes: StorageChanges;
  readonly signal: AbortSignal;
}): Computed<Promise<readonly FileEntryWithHash[]>> {
  return computed(async (get): Promise<readonly FileEntryWithHash[]> => {
    const [baseVersionRecord] = await args.db
      .select()
      .from(storageVersions)
      .where(
        and(
          eq(storageVersions.storageId, args.storageId),
          eq(storageVersions.id, args.baseVersion),
        ),
      )
      .limit(1);
    args.signal.throwIfAborted();

    if (!baseVersionRecord) {
      return args.files;
    }

    if (baseVersionRecord.fileCount === 0) {
      return args.files;
    }

    const baseManifest = await get(
      downloadManifest(args.bucket, baseVersionRecord.s3Key),
    );
    args.signal.throwIfAborted();

    const currentFiles = new Map(
      args.files.map((file) => {
        return [file.path, file];
      }),
    );
    const deleted = new Set(args.changes.deleted ?? []);
    const baseFiles = baseManifest.files.filter((file) => {
      return !deleted.has(file.path) && !currentFiles.has(file.path);
    });

    return [...baseFiles, ...args.files];
  });
}

function totalSize(files: readonly FileEntryWithHash[]): number {
  return files.reduce((sum, file) => {
    return sum + file.size;
  }, 0);
}

async function findStorageVersion(args: {
  readonly db: Db;
  readonly storageId: string;
  readonly versionId: string;
}): Promise<StorageVersionRow | undefined> {
  const [version] = await args.db
    .select()
    .from(storageVersions)
    .where(
      and(
        eq(storageVersions.storageId, args.storageId),
        eq(storageVersions.id, args.versionId),
      ),
    )
    .limit(1);

  return version;
}

async function findStorageById(args: {
  readonly db: Db;
  readonly storageId: string;
}): Promise<StorageRow | undefined> {
  const [storage] = await args.db
    .select(storageRowSelection())
    .from(storages)
    .where(eq(storages.id, args.storageId))
    .limit(1);

  return storage;
}

async function resolveStorageForPrepare(args: {
  readonly db: Db;
  readonly input: PrepareStorageInput;
  readonly signal: AbortSignal;
}): Promise<StorageRow | StorageErrorResponse> {
  return await findMountedWritebackStorage({
    db: args.db,
    auth: args.input.auth,
    storageId: args.input.storageId,
    signal: args.signal,
  });
}

async function resolveStorageForCommit(args: {
  readonly db: Db;
  readonly input: CommitStorageInput;
  readonly signal: AbortSignal;
}): Promise<StorageRow | StorageErrorResponse> {
  return await findMountedWritebackStorage({
    db: args.db,
    auth: args.input.auth,
    storageId: args.input.storageId,
    signal: args.signal,
  });
}

function resolvePreparedFiles(args: {
  readonly db: Db;
  readonly bucket: string;
  readonly storageId: string;
  readonly input: PrepareStorageUploadInput;
  readonly signal: AbortSignal;
}): Computed<Promise<readonly FileEntryWithHash[]>> {
  return computed(async (get): Promise<readonly FileEntryWithHash[]> => {
    const baseVersion = args.input.baseVersion;
    const changes = args.input.changes;
    if (!baseVersion || !changes) {
      return args.input.files;
    }

    const files = await get(
      mergeWithBaseVersion({
        db: args.db,
        bucket: args.bucket,
        storageId: args.storageId,
        files: args.input.files,
        baseVersion,
        changes,
        signal: args.signal,
      }),
    );
    args.signal.throwIfAborted();

    return files;
  });
}

function existingStorageVersionIsReusable(args: {
  readonly db: Db;
  readonly bucket: string;
  readonly storageId: string;
  readonly allowMissingObjectsForEmptyVersion: boolean;
  readonly versionId: string;
  readonly force: boolean | undefined;
  readonly signal: AbortSignal;
}): Computed<Promise<boolean>> {
  return computed(async (get): Promise<boolean> => {
    if (args.force) {
      return false;
    }

    const existingVersion = await findStorageVersion({
      db: args.db,
      storageId: args.storageId,
      versionId: args.versionId,
    });
    args.signal.throwIfAborted();

    if (!existingVersion) {
      return false;
    }

    const exists = await get(
      verifyS3FilesExist(
        args.bucket,
        existingVersion.s3Key,
        existingVersion.fileCount,
        {
          allowMissingObjectsForEmptyVersion:
            args.allowMissingObjectsForEmptyVersion,
        },
      ),
    );
    args.signal.throwIfAborted();

    return exists;
  });
}

function createStorageUploadResponse(args: {
  readonly bucket: string;
  readonly storage: StorageRow;
  readonly versionId: string;
  readonly signal: AbortSignal;
}): Computed<Promise<PrepareStorageResponse>> {
  return computed(async (get): Promise<PrepareStorageResponse> => {
    const s3Key = `${args.storage.s3Prefix}/${args.versionId}`;
    const archiveKey = `${s3Key}/archive.tar.gz`;
    const manifestKey = `${s3Key}/manifest.json`;
    const [archiveUrl, manifestUrl] = await Promise.all([
      get(
        generatePresignedPutUrl(
          args.bucket,
          archiveKey,
          "application/gzip",
          3600,
          true,
        ),
      ),
      get(
        generatePresignedPutUrl(
          args.bucket,
          manifestKey,
          "application/json",
          3600,
          true,
        ),
      ),
    ]);
    args.signal.throwIfAborted();

    return {
      status: 200,
      body: {
        versionId: args.versionId,
        existing: false,
        uploads: {
          archive: { key: archiveKey, presignedUrl: archiveUrl },
          manifest: { key: manifestKey, presignedUrl: manifestUrl },
        },
      },
    };
  });
}

function s3FilesMissingConflict(): Extract<
  CommitStorageResponse,
  { status: 409 }
> {
  return {
    status: 409,
    body: {
      error: {
        message: "S3 files missing for existing version - please retry upload",
        code: "S3_FILES_MISSING",
      },
    },
  };
}

type ArchiveVerification =
  | { readonly kind: "verified"; readonly archiveSize: number }
  | { readonly kind: "missing-archive" }
  | { readonly kind: "invalid-archive-size" };

type UploadedStorageFilesVerification =
  | ArchiveVerification
  | { readonly kind: "missing-manifest" };

function verifyArchiveHead(
  archiveHead: S3ObjectHead,
  fileCount: number,
): ArchiveVerification {
  if (archiveHead.kind === "missing") {
    return fileCount === 0
      ? { kind: "verified", archiveSize: 0 }
      : { kind: "missing-archive" };
  }

  const archiveSize = archiveHead.contentLength;
  if (
    archiveSize === undefined ||
    !Number.isSafeInteger(archiveSize) ||
    archiveSize <= 0
  ) {
    return { kind: "invalid-archive-size" };
  }
  return { kind: "verified", archiveSize };
}

function verifyUploadedStorageFiles(args: {
  readonly bucket: string;
  readonly s3Key: string;
  readonly fileCount: number;
  readonly signal: AbortSignal;
}): Computed<Promise<UploadedStorageFilesVerification>> {
  return computed(async (get): Promise<UploadedStorageFilesVerification> => {
    const manifestKey = `${args.s3Key}/manifest.json`;
    const archiveKey = `${args.s3Key}/archive.tar.gz`;
    const [manifestExists, archiveHead] = await Promise.all([
      get(s3ObjectExists(args.bucket, manifestKey)),
      get(s3ObjectHead(args.bucket, archiveKey)),
    ]);
    args.signal.throwIfAborted();

    if (!manifestExists) {
      return { kind: "missing-manifest" };
    }
    return verifyArchiveHead(archiveHead, args.fileCount);
  });
}

function commitExistingStorageVersion(args: {
  readonly db: Db;
  readonly bucket: string;
  readonly storage: StorageRow;
  readonly version: StorageVersionRow;
  readonly input: CommitStorageUploadInput;
  readonly signal: AbortSignal;
}): Computed<Promise<CommitStorageResponse>> {
  return computed(async (get): Promise<CommitStorageResponse> => {
    const explicitEmptyVersion = args.version.fileCount === 0;
    const verification = explicitEmptyVersion
      ? null
      : await get(
          verifyUploadedStorageFiles({
            bucket: args.bucket,
            s3Key: args.version.s3Key,
            fileCount: args.version.fileCount,
            signal: args.signal,
          }),
        );
    args.signal.throwIfAborted();

    if (verification && verification.kind !== "verified") {
      return s3FilesMissingConflict();
    }

    const verifiedArchiveSize =
      verification?.kind === "verified" ? verification.archiveSize : undefined;
    const archiveSizeChanged =
      verifiedArchiveSize !== undefined &&
      args.version.archiveSize !== verifiedArchiveSize;
    const headChanged = args.storage.headVersionId !== args.input.versionId;
    if (archiveSizeChanged || headChanged) {
      await args.db.transaction(async (tx) => {
        if (archiveSizeChanged) {
          await tx
            .update(storageVersions)
            .set({ archiveSize: verifiedArchiveSize })
            .where(
              and(
                eq(storageVersions.id, args.version.id),
                eq(storageVersions.storageId, args.storage.id),
              ),
            );
        }
        if (headChanged) {
          await tx
            .update(storages)
            .set({
              headVersionId: args.input.versionId,
              updatedAt: nowDate(),
            })
            .where(eq(storages.id, args.storage.id));
        }
      });
      args.signal.throwIfAborted();
    }

    return {
      status: 200,
      body: {
        success: true,
        versionId: args.input.versionId,
        storageName: args.storage.name,
        size: Number(args.version.size),
        fileCount: args.version.fileCount,
        deduplicated: true,
      },
    };
  });
}

async function insertStorageVersionAndUpdateHead(args: {
  readonly db: Db;
  readonly storageId: string;
  readonly s3Key: string;
  readonly input: CommitStorageUploadInput;
  readonly size: number;
  readonly archiveSize: number;
  readonly fileCount: number;
}): Promise<void> {
  await args.db.transaction(async (tx) => {
    const [insertedVersion] = await tx
      .insert(storageVersions)
      .values({
        id: args.input.versionId,
        storageId: args.storageId,
        s3Key: args.s3Key,
        size: args.size,
        archiveSize: args.archiveSize,
        fileCount: args.fileCount,
        message: args.input.message ?? null,
        createdBy: args.input.runId ? "agent" : "user",
      })
      .onConflictDoNothing()
      .returning({ id: storageVersions.id });

    let version = insertedVersion;
    if (!version) {
      const [updatedVersion] = await tx
        .update(storageVersions)
        .set({ archiveSize: args.archiveSize })
        .where(
          and(
            eq(storageVersions.storageId, args.storageId),
            eq(storageVersions.id, args.input.versionId),
          ),
        )
        .returning({ id: storageVersions.id });
      version = updatedVersion;
    }

    if (!version) {
      throw new Error(`Version ${args.input.versionId} not found after insert`);
    }

    await tx
      .update(storages)
      .set({
        headVersionId: args.input.versionId,
        size: args.size,
        fileCount: args.fileCount,
        updatedAt: nowDate(),
      })
      .where(eq(storages.id, args.storageId));
  });
}

function commitNewStorageVersion(args: {
  readonly db: Db;
  readonly bucket: string;
  readonly storage: StorageRow;
  readonly input: CommitStorageUploadInput;
  readonly signal: AbortSignal;
}): Computed<Promise<CommitStorageResponse>> {
  return computed(async (get): Promise<CommitStorageResponse> => {
    const s3Key = `${args.storage.s3Prefix}/${args.input.versionId}`;
    const fileCount = args.input.files.length;
    const uploadVerification = await get(
      verifyUploadedStorageFiles({
        bucket: args.bucket,
        s3Key,
        fileCount,
        signal: args.signal,
      }),
    );
    if (uploadVerification.kind !== "verified") {
      switch (uploadVerification.kind) {
        case "missing-manifest": {
          return badRequestMessage(
            "Manifest not uploaded - upload failed or incomplete",
          );
        }
        case "missing-archive": {
          return badRequestMessage(
            "Archive not uploaded - upload failed or incomplete",
          );
        }
        case "invalid-archive-size": {
          return badRequestMessage(
            "Archive has invalid or missing content length",
          );
        }
      }
    }

    const size = totalSize(args.input.files);
    await insertStorageVersionAndUpdateHead({
      db: args.db,
      storageId: args.storage.id,
      s3Key,
      input: args.input,
      size,
      archiveSize: uploadVerification.archiveSize,
      fileCount,
    });
    args.signal.throwIfAborted();

    return {
      status: 200,
      body: {
        success: true,
        versionId: args.input.versionId,
        storageName: args.storage.name,
        size,
        fileCount,
      },
    };
  });
}

async function recordStorageLineage(args: {
  readonly db: Db;
  readonly storageId: string;
  readonly versionId: string;
  readonly parentVersionId: string | undefined;
  readonly runId: string | undefined;
}): Promise<void> {
  const parentVersionId = args.parentVersionId;
  const runId = args.runId;
  if (!parentVersionId || !runId) {
    return;
  }

  await tapError(
    args.db.insert(storageVersionLineage).values({
      storageId: args.storageId,
      versionId: args.versionId,
      parentVersionId,
      runId,
    }),
    (error) => {
      L.error(
        `Failed to record lineage for ${args.versionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    },
  );
}

export const prepareStorageUploadForStorage$ = command(
  async (
    { get, set },
    args: PrepareStorageForStorageInput,
    signal: AbortSignal,
  ): Promise<PrepareStorageResponse> => {
    const declaredSize = totalSize(args.files);
    if (declaredSize > MAX_FILE_SIZE_BYTES) {
      return payloadTooLarge(
        "Upload rejected: total file size exceeds 100MB limit",
      );
    }

    const writeDb = set(writeDb$);
    const storage = await findStorageById({
      db: writeDb,
      storageId: args.storageId,
    });
    signal.throwIfAborted();

    if (!storage) {
      return notFound("Storage not found");
    }

    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    if (!bucket) {
      return storageServiceNotConfigured();
    }

    const mergedFiles = await get(
      resolvePreparedFiles({
        db: writeDb,
        bucket,
        storageId: storage.id,
        input: args,
        signal,
      }),
    );
    signal.throwIfAborted();
    const versionId = computeContentHashFromHashes(storage.id, mergedFiles);

    const existingReusable = await get(
      existingStorageVersionIsReusable({
        db: writeDb,
        bucket,
        storageId: storage.id,
        allowMissingObjectsForEmptyVersion: true,
        versionId,
        force: args.force,
        signal,
      }),
    );
    signal.throwIfAborted();
    if (existingReusable) {
      return { status: 200, body: { versionId, existing: true } };
    }

    return await get(
      createStorageUploadResponse({
        bucket,
        storage,
        versionId,
        signal,
      }),
    );
  },
);

export const commitStorageUploadForStorage$ = command(
  async (
    { get, set },
    args: CommitStorageForStorageInput,
    signal: AbortSignal,
  ): Promise<CommitStorageResponse> => {
    const writeDb = set(writeDb$);
    const storage = await findStorageById({
      db: writeDb,
      storageId: args.storageId,
    });
    signal.throwIfAborted();

    if (!storage) {
      return notFound("Storage not found");
    }

    const computedVersionId = computeContentHashFromHashes(
      storage.id,
      args.files,
    );
    if (computedVersionId !== args.versionId) {
      return badRequestMessage("Version ID mismatch - files may have changed");
    }

    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    if (!bucket) {
      return storageServiceNotConfigured();
    }

    const existingVersion = await findStorageVersion({
      db: writeDb,
      storageId: storage.id,
      versionId: args.versionId,
    });
    signal.throwIfAborted();

    if (existingVersion) {
      return await get(
        commitExistingStorageVersion({
          db: writeDb,
          bucket,
          storage,
          version: existingVersion,
          input: args,
          signal,
        }),
      );
    }

    const response = await get(
      commitNewStorageVersion({
        db: writeDb,
        bucket,
        storage,
        input: args,
        signal,
      }),
    );
    signal.throwIfAborted();

    if (response.status === 200) {
      await recordStorageLineage({
        db: writeDb,
        storageId: storage.id,
        versionId: args.versionId,
        parentVersionId: args.parentVersionId,
        runId: args.runId,
      });
      signal.throwIfAborted();
    }

    return response;
  },
);

export const prepareStorageUploadForAuth$ = command(
  async (
    { set },
    args: PrepareStorageInput,
    signal: AbortSignal,
  ): Promise<PrepareStorageResponse> => {
    const writeDb = set(writeDb$);
    const storage = await resolveStorageForPrepare({
      db: writeDb,
      input: args,
      signal,
    });
    signal.throwIfAborted();

    if ("status" in storage) {
      return storage;
    }

    const upload: PrepareStorageForStorageInput = args;
    return await set(prepareStorageUploadForStorage$, upload, signal);
  },
);

export const commitStorageUploadForAuth$ = command(
  async (
    { set },
    args: CommitStorageInput,
    signal: AbortSignal,
  ): Promise<CommitStorageResponse> => {
    const writeDb = set(writeDb$);
    const storage = await resolveStorageForCommit({
      db: writeDb,
      input: args,
      signal,
    });
    signal.throwIfAborted();

    if ("status" in storage) {
      return storage;
    }

    const upload: CommitStorageForStorageInput = args;
    return await set(commitStorageUploadForStorage$, upload, signal);
  },
);
