import { MAX_FILE_SIZE_BYTES } from "@vm0/api-contracts/contracts/storages";
import { VOLUME_ORG_USER_ID } from "@vm0/core/storage-names";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { command, type Computed } from "ccstate";
import { and, eq } from "drizzle-orm";

import { badRequestMessage, notFound } from "../../lib/error";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import type { AuthContext } from "../../types/auth";
import { writeDb$, type Db } from "../external/db";
import {
  downloadManifest,
  generatePresignedPutUrl,
  s3ObjectExists,
  verifyS3FilesExist,
} from "../external/s3";
import { safeAsync } from "../utils";
import {
  computeContentHashFromHashes,
  type FileEntryWithHash,
} from "./storage-content-hash.service";

type StorageType = "volume" | "artifact";

interface StorageChanges {
  readonly deleted?: readonly string[];
}

interface PrepareStorageInput {
  readonly auth: AuthContext;
  readonly storageName: string;
  readonly storageType: StorageType;
  readonly files: readonly FileEntryWithHash[];
  readonly force?: boolean;
  readonly runId?: string;
  readonly baseVersion?: string;
  readonly changes?: StorageChanges;
}

interface CommitStorageInput {
  readonly auth: AuthContext;
  readonly storageName: string;
  readonly storageType: StorageType;
  readonly versionId: string;
  readonly files: readonly FileEntryWithHash[];
  readonly runId?: string;
  readonly message?: string;
}

interface RuntimeOrg {
  readonly orgId: string;
}

type StorageRow = typeof storages.$inferSelect;
type StorageVersionRow = typeof storageVersions.$inferSelect;

type SignalGetter = {
  <T>(source: Computed<T>): T;
  <T>(source: Computed<Promise<T>>): Promise<T>;
};

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

function hasRunId(auth: AuthContext): auth is AuthContext & {
  readonly runId: string;
} {
  return "runId" in auth && typeof auth.runId === "string";
}

function storageUserId(type: StorageType, userId: string): string {
  return type === "volume" ? VOLUME_ORG_USER_ID : userId;
}

async function resolveStorageRuntimeOrg(args: {
  readonly db: Db;
  readonly auth: AuthContext;
  readonly runId: string | undefined;
  readonly signal: AbortSignal;
}): Promise<RuntimeOrg | StorageErrorResponse> {
  if (hasRunId(args.auth)) {
    const [run] = await args.db
      .select({ orgId: agentRuns.orgId })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, args.auth.runId),
          eq(agentRuns.userId, args.auth.userId),
        ),
      )
      .limit(1);
    args.signal.throwIfAborted();

    return run ? { orgId: run.orgId } : notFound("Agent run not found");
  }

  if (!args.auth.orgId) {
    return badRequestMessage(
      "Explicit org context required — ensure active org in session",
    );
  }

  if (args.runId) {
    const [run] = await args.db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, args.runId),
          eq(agentRuns.userId, args.auth.userId),
        ),
      )
      .limit(1);
    args.signal.throwIfAborted();

    if (!run) {
      return notFound("Agent run not found");
    }
  }

  return { orgId: args.auth.orgId };
}

async function mergeWithBaseVersion(args: {
  readonly get: SignalGetter;
  readonly db: Db;
  readonly bucket: string;
  readonly storageId: string;
  readonly files: readonly FileEntryWithHash[];
  readonly baseVersion: string;
  readonly changes: StorageChanges;
  readonly signal: AbortSignal;
}): Promise<readonly FileEntryWithHash[]> {
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

  const baseManifest = await args.get(
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
}

function totalSize(files: readonly FileEntryWithHash[]): number {
  return files.reduce((sum, file) => {
    return sum + file.size;
  }, 0);
}

async function findStorageForCommit(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly storageOwner: string;
  readonly input: CommitStorageInput;
}): Promise<StorageRow | undefined> {
  const [storage] = await args.db
    .select()
    .from(storages)
    .where(
      and(
        eq(storages.orgId, args.orgId),
        eq(storages.userId, args.storageOwner),
        eq(storages.name, args.input.storageName),
        eq(storages.type, args.input.storageType),
      ),
    )
    .limit(1);

  return storage;
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

async function upsertStorageForPrepare(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly storageOwner: string;
  readonly input: PrepareStorageInput;
}): Promise<StorageRow | undefined> {
  const [storage] = await args.db
    .insert(storages)
    .values({
      userId: args.storageOwner,
      orgId: args.orgId,
      name: args.input.storageName,
      type: args.input.storageType,
      s3Prefix: `${args.orgId}/${args.input.storageType}/${args.input.storageName}`,
      size: 0,
      fileCount: 0,
    })
    .onConflictDoUpdate({
      target: [storages.orgId, storages.userId, storages.name, storages.type],
      set: { updatedAt: nowDate() },
    })
    .returning();

  return storage;
}

async function resolvePreparedFiles(args: {
  readonly get: SignalGetter;
  readonly db: Db;
  readonly bucket: string;
  readonly storageId: string;
  readonly input: PrepareStorageInput;
  readonly signal: AbortSignal;
}): Promise<readonly FileEntryWithHash[]> {
  const baseVersion = args.input.baseVersion;
  const changes = args.input.changes;
  if (!baseVersion || !changes) {
    return args.input.files;
  }

  const mergeResult = await safeAsync(() => {
    return mergeWithBaseVersion({
      get: args.get,
      db: args.db,
      bucket: args.bucket,
      storageId: args.storageId,
      files: args.input.files,
      baseVersion,
      changes,
      signal: args.signal,
    });
  });
  args.signal.throwIfAborted();

  return "ok" in mergeResult ? mergeResult.ok : args.input.files;
}

async function existingStorageVersionIsReusable(args: {
  readonly get: SignalGetter;
  readonly db: Db;
  readonly bucket: string;
  readonly storageId: string;
  readonly versionId: string;
  readonly force: boolean | undefined;
  readonly signal: AbortSignal;
}): Promise<boolean> {
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

  const exists = await args.get(
    verifyS3FilesExist(
      args.bucket,
      existingVersion.s3Key,
      existingVersion.fileCount,
    ),
  );
  args.signal.throwIfAborted();

  return exists;
}

async function createStorageUploadResponse(args: {
  readonly get: SignalGetter;
  readonly bucket: string;
  readonly storage: StorageRow;
  readonly versionId: string;
  readonly signal: AbortSignal;
}): Promise<PrepareStorageResponse> {
  const s3Key = `${args.storage.s3Prefix}/${args.versionId}`;
  const archiveKey = `${s3Key}/archive.tar.gz`;
  const manifestKey = `${s3Key}/manifest.json`;
  const [archiveUrl, manifestUrl] = await Promise.all([
    args.get(
      generatePresignedPutUrl(
        args.bucket,
        archiveKey,
        "application/gzip",
        3600,
        true,
      ),
    ),
    args.get(
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

async function commitExistingStorageVersion(args: {
  readonly get: SignalGetter;
  readonly db: Db;
  readonly bucket: string;
  readonly storage: StorageRow;
  readonly version: StorageVersionRow;
  readonly input: CommitStorageInput;
  readonly signal: AbortSignal;
}): Promise<CommitStorageResponse> {
  const exists = await args.get(
    verifyS3FilesExist(args.bucket, args.version.s3Key, args.version.fileCount),
  );
  args.signal.throwIfAborted();

  if (!exists) {
    return s3FilesMissingConflict();
  }

  if (args.storage.headVersionId !== args.input.versionId) {
    await args.db
      .update(storages)
      .set({ headVersionId: args.input.versionId, updatedAt: nowDate() })
      .where(eq(storages.id, args.storage.id));
    args.signal.throwIfAborted();
  }

  return {
    status: 200,
    body: {
      success: true,
      versionId: args.input.versionId,
      storageName: args.input.storageName,
      size: Number(args.version.size),
      fileCount: args.version.fileCount,
      deduplicated: true,
    },
  };
}

async function verifyUploadedStorageFiles(args: {
  readonly get: SignalGetter;
  readonly bucket: string;
  readonly s3Key: string;
  readonly fileCount: number;
  readonly signal: AbortSignal;
}): Promise<ReturnType<typeof badRequestMessage> | null> {
  const manifestKey = `${args.s3Key}/manifest.json`;
  const archiveKey = `${args.s3Key}/archive.tar.gz`;
  const [manifestExists, archiveExists] = await Promise.all([
    args.get(s3ObjectExists(args.bucket, manifestKey)),
    args.fileCount > 0
      ? args.get(s3ObjectExists(args.bucket, archiveKey))
      : Promise.resolve(true),
  ]);
  args.signal.throwIfAborted();

  if (!manifestExists) {
    return badRequestMessage(
      "Manifest not uploaded - upload failed or incomplete",
    );
  }

  if (args.fileCount > 0 && !archiveExists) {
    return badRequestMessage(
      "Archive not uploaded - upload failed or incomplete",
    );
  }

  return null;
}

async function insertStorageVersionAndUpdateHead(args: {
  readonly db: Db;
  readonly storageId: string;
  readonly s3Key: string;
  readonly input: CommitStorageInput;
  readonly size: number;
  readonly fileCount: number;
}): Promise<void> {
  await args.db.transaction(async (tx) => {
    await tx
      .insert(storageVersions)
      .values({
        id: args.input.versionId,
        storageId: args.storageId,
        s3Key: args.s3Key,
        size: args.size,
        fileCount: args.fileCount,
        message: args.input.message ?? null,
        createdBy: args.input.runId ? "agent" : "user",
      })
      .onConflictDoNothing();

    const [version] = await tx
      .select({ id: storageVersions.id })
      .from(storageVersions)
      .where(
        and(
          eq(storageVersions.storageId, args.storageId),
          eq(storageVersions.id, args.input.versionId),
        ),
      )
      .limit(1);

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

async function commitNewStorageVersion(args: {
  readonly get: SignalGetter;
  readonly db: Db;
  readonly bucket: string;
  readonly storage: StorageRow;
  readonly input: CommitStorageInput;
  readonly signal: AbortSignal;
}): Promise<CommitStorageResponse> {
  const s3Key = `${args.storage.s3Prefix}/${args.input.versionId}`;
  const fileCount = args.input.files.length;
  const uploadError = await verifyUploadedStorageFiles({
    get: args.get,
    bucket: args.bucket,
    s3Key,
    fileCount,
    signal: args.signal,
  });
  if (uploadError) {
    return uploadError;
  }

  const size = totalSize(args.input.files);
  await insertStorageVersionAndUpdateHead({
    db: args.db,
    storageId: args.storage.id,
    s3Key,
    input: args.input,
    size,
    fileCount,
  });
  args.signal.throwIfAborted();

  return {
    status: 200,
    body: {
      success: true,
      versionId: args.input.versionId,
      storageName: args.input.storageName,
      size,
      fileCount,
    },
  };
}

export const prepareStorageUploadForAuth$ = command(
  async (
    { get, set },
    args: PrepareStorageInput,
    signal: AbortSignal,
  ): Promise<PrepareStorageResponse> => {
    const declaredSize = totalSize(args.files);
    if (declaredSize > MAX_FILE_SIZE_BYTES) {
      return payloadTooLarge(
        "Upload rejected: total file size exceeds 100MB limit",
      );
    }

    const writeDb = set(writeDb$);
    const runtimeOrg = await resolveStorageRuntimeOrg({
      db: writeDb,
      auth: args.auth,
      runId: args.runId,
      signal,
    });
    if ("status" in runtimeOrg) {
      return runtimeOrg;
    }

    const storageOwner = storageUserId(args.storageType, args.auth.userId);
    const storage = await upsertStorageForPrepare({
      db: writeDb,
      orgId: runtimeOrg.orgId,
      storageOwner,
      input: args,
    });
    signal.throwIfAborted();

    if (!storage) {
      return internalError("Failed to create storage");
    }

    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    if (!bucket) {
      return storageServiceNotConfigured();
    }

    const mergedFiles = await resolvePreparedFiles({
      get,
      db: writeDb,
      bucket,
      storageId: storage.id,
      input: args,
      signal,
    });
    const versionId = computeContentHashFromHashes(storage.id, mergedFiles);

    const existingReusable = await existingStorageVersionIsReusable({
      get,
      db: writeDb,
      bucket,
      storageId: storage.id,
      versionId,
      force: args.force,
      signal,
    });
    if (existingReusable) {
      return { status: 200, body: { versionId, existing: true } };
    }

    return await createStorageUploadResponse({
      get,
      bucket,
      storage,
      versionId,
      signal,
    });
  },
);

export const commitStorageUploadForAuth$ = command(
  async (
    { get, set },
    args: CommitStorageInput,
    signal: AbortSignal,
  ): Promise<CommitStorageResponse> => {
    const writeDb = set(writeDb$);
    const runtimeOrg = await resolveStorageRuntimeOrg({
      db: writeDb,
      auth: args.auth,
      runId: args.runId,
      signal,
    });
    if ("status" in runtimeOrg) {
      return runtimeOrg;
    }

    const storageOwner = storageUserId(args.storageType, args.auth.userId);
    const storage = await findStorageForCommit({
      db: writeDb,
      orgId: runtimeOrg.orgId,
      storageOwner,
      input: args,
    });
    signal.throwIfAborted();

    if (!storage) {
      return notFound(`Storage "${args.storageName}" not found`);
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
      return await commitExistingStorageVersion({
        get,
        db: writeDb,
        bucket,
        storage,
        version: existingVersion,
        input: args,
        signal,
      });
    }

    return await commitNewStorageVersion({
      get,
      db: writeDb,
      bucket,
      storage,
      input: args,
      signal,
    });
  },
);
