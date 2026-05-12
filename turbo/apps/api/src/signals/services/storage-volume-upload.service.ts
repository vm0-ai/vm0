import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

import { VOLUME_ORG_USER_ID } from "@vm0/core/storage-names";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { create } from "tar";

import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { putS3Object } from "../external/s3";
import {
  computeContentHashFromHashes,
  hashFileContent,
  type FileEntryWithHash,
} from "./storage-content-hash.service";

interface VolumeFileInput {
  readonly path: string;
  readonly content: string;
}

interface UploadVolumeInput {
  readonly orgId: string;
  readonly storageName: string;
  readonly files: readonly VolumeFileInput[];
}

interface UploadedVolume {
  readonly storageName: string;
  readonly versionId: string;
}

interface S3StorageManifest {
  readonly version: string;
  readonly createdAt: string;
  readonly totalSize: number;
  readonly fileCount: number;
  readonly files: readonly FileEntryWithHash[];
}

interface MaterializedVolumeFile extends FileEntryWithHash {
  readonly content: Buffer;
}

async function bufferFromStream(
  stream: AsyncIterable<Uint8Array>,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function materializeFiles(
  files: readonly VolumeFileInput[],
): readonly MaterializedVolumeFile[] {
  return files.map((file) => {
    const content = Buffer.from(file.content, "utf8");
    return {
      path: file.path,
      content,
      hash: hashFileContent(content),
      size: content.length,
    };
  });
}

function writeFilesToDirectory(
  tmpDir: string,
  files: readonly MaterializedVolumeFile[],
): void {
  for (const file of files) {
    const filePath = resolve(join(tmpDir, file.path));
    const relativePath = relative(tmpDir, filePath);
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      throw new Error(`Invalid file path: ${file.path}`);
    }
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, file.content);
  }
}

function createArchiveBuffer(
  tmpDir: string,
  files: readonly MaterializedVolumeFile[],
): Promise<Buffer> {
  return bufferFromStream(
    create(
      {
        gzip: true,
        cwd: tmpDir,
      },
      files.map((file) => {
        return file.path;
      }),
    ),
  );
}

const uploadVolumeServerSideInner$ = command(
  async (
    { get, set },
    args: UploadVolumeInput,
    signal: AbortSignal,
  ): Promise<UploadedVolume> => {
    const files = materializeFiles(args.files);
    const totalSize = files.reduce((sum, file) => {
      return sum + file.size;
    }, 0);

    const tmpDir = await mkdtemp(join(tmpdir(), "vm0-api-volume-"));
    signal.throwIfAborted();

    const archiveBuffer = await Promise.resolve()
      .then(() => {
        writeFilesToDirectory(tmpDir, files);
        return createArchiveBuffer(tmpDir, files);
      })
      .finally(() => {
        rmSync(tmpDir, { recursive: true, force: true });
      });
    signal.throwIfAborted();

    const writeDb = set(writeDb$);
    const storageType = "volume";
    const s3Prefix = `${args.orgId}/${storageType}/${args.storageName}`;
    const timestamp = nowDate();

    const [storage] = await writeDb
      .insert(storages)
      .values({
        userId: VOLUME_ORG_USER_ID,
        orgId: args.orgId,
        name: args.storageName,
        type: storageType,
        s3Prefix,
        size: 0,
        fileCount: 0,
      })
      .onConflictDoUpdate({
        target: [storages.orgId, storages.userId, storages.name, storages.type],
        set: { updatedAt: timestamp },
      })
      .returning();
    signal.throwIfAborted();

    if (!storage) {
      throw new Error(`Failed to create storage for ${args.storageName}`);
    }

    const fileEntries = files.map((file) => {
      return {
        path: file.path,
        hash: file.hash,
        size: file.size,
      };
    });
    const versionId = computeContentHashFromHashes(storage.id, fileEntries);
    const s3Key = `${s3Prefix}/${versionId}`;
    const bucketName = env("R2_USER_STORAGES_BUCKET_NAME");
    const manifest: S3StorageManifest = {
      version: versionId,
      createdAt: timestamp.toISOString(),
      totalSize,
      fileCount: files.length,
      files: fileEntries,
    };

    await Promise.all([
      get(
        putS3Object(
          bucketName,
          `${s3Key}/archive.tar.gz`,
          archiveBuffer,
          "application/gzip",
        ),
      ),
      get(
        putS3Object(
          bucketName,
          `${s3Key}/manifest.json`,
          JSON.stringify(manifest),
          "application/json",
        ),
      ),
    ]);
    signal.throwIfAborted();

    await writeDb.transaction(async (tx) => {
      await tx
        .insert(storageVersions)
        .values({
          id: versionId,
          storageId: storage.id,
          s3Key,
          size: totalSize,
          fileCount: files.length,
          message: null,
          createdBy: "user",
        })
        .onConflictDoNothing();
      signal.throwIfAborted();

      const [version] = await tx
        .select({ id: storageVersions.id })
        .from(storageVersions)
        .where(
          and(
            eq(storageVersions.storageId, storage.id),
            eq(storageVersions.id, versionId),
          ),
        )
        .limit(1);
      signal.throwIfAborted();

      if (!version) {
        throw new Error(`Version ${versionId} not found after insert`);
      }

      await tx
        .update(storages)
        .set({
          headVersionId: versionId,
          size: totalSize,
          fileCount: files.length,
          updatedAt: timestamp,
        })
        .where(eq(storages.id, storage.id));
      signal.throwIfAborted();
    });
    signal.throwIfAborted();

    return { storageName: args.storageName, versionId };
  },
);

export const uploadVolumeServerSide$ = uploadVolumeServerSideInner$;
