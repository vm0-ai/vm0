import { posix } from "node:path";

import type { Computed } from "ccstate";
import type { RunSkillSnapshot } from "@vm0/api-contracts/contracts/runners";
import { storageVersions } from "@vm0/db/schema/storage";
import type { PersistedStorageMount } from "@vm0/db/types";
import {
  ExecutionError,
  FileError,
  type ExecutionEnv,
  type FileInfo,
  type Result,
} from "@vm0/pi-agent-runtime";
import { inArray } from "drizzle-orm";

import { env } from "../../lib/env";
import { extractBinaryFilesFromTarGz } from "../../lib/tar";
import type { Db } from "../external/db";
import { downloadS3Buffer } from "../external/s3";

interface StorageFile {
  readonly path: string;
  readonly content: Uint8Array;
}

interface StorageVersionIdentity {
  readonly storageId: string;
  readonly versionId: string;
}

interface LoadedStorageVersion extends StorageVersionIdentity {
  readonly files: readonly {
    readonly path: string;
    readonly content: Buffer;
  }[];
}

interface PiLaunchStorageResources {
  readonly env: ExecutionEnv;
  readonly agentInstructions: string | null;
}

function success<T>(value: T): Result<T, FileError> {
  return { ok: true, value };
}

function failure<T>(
  code: ConstructorParameters<typeof FileError>[0],
  message: string,
  path?: string,
): Result<T, FileError> {
  return { ok: false, error: new FileError(code, message, path) };
}

function executionFailure(
  code: ConstructorParameters<typeof ExecutionError>[0],
  message: string,
): Result<
  {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
  },
  ExecutionError
> {
  return { ok: false, error: new ExecutionError(code, message) };
}

/** Read-only Pi filesystem materialized from this run's exact Storage versions. */
class StorageExecutionEnv implements ExecutionEnv {
  readonly cwd = "/home/user/workspace";
  private readonly files = new Map<string, Uint8Array>();
  private readonly directories = new Set<string>(["/"]);

  constructor(files: readonly StorageFile[]) {
    for (const file of files) {
      const path = this.resolve(file.path);
      this.files.set(path, Uint8Array.from(file.content));
      let directory = posix.dirname(path);
      while (!this.directories.has(directory)) {
        this.directories.add(directory);
        if (directory === "/") {
          break;
        }
        directory = posix.dirname(directory);
      }
    }
  }

  private resolve(path: string): string {
    return posix.isAbsolute(path)
      ? posix.resolve(path)
      : posix.resolve(this.cwd, path);
  }

  private aborted<T>(
    signal: AbortSignal | undefined,
    path?: string,
  ): Result<T, FileError> | null {
    return signal?.aborted
      ? failure("aborted", "Operation aborted", path)
      : null;
  }

  absolutePath(
    path: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<string, FileError>> {
    return Promise.resolve(
      this.aborted<string>(abortSignal, path) ?? success(this.resolve(path)),
    );
  }

  joinPath(
    parts: string[],
    abortSignal?: AbortSignal,
  ): Promise<Result<string, FileError>> {
    return Promise.resolve(
      this.aborted<string>(abortSignal) ?? success(posix.join(...parts)),
    );
  }

  readTextFile(
    path: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<string, FileError>> {
    const absolute = this.resolve(path);
    const aborted = this.aborted<string>(abortSignal, absolute);
    if (aborted) {
      return Promise.resolve(aborted);
    }
    const content = this.files.get(absolute);
    return Promise.resolve(
      content
        ? success(Buffer.from(content).toString("utf8"))
        : failure("not_found", `File not found: ${absolute}`, absolute),
    );
  }

  readTextLines(
    path: string,
    options?: {
      readonly maxLines?: number;
      readonly abortSignal?: AbortSignal;
    },
  ): Promise<Result<string[], FileError>> {
    const absolute = this.resolve(path);
    const aborted = this.aborted<string[]>(options?.abortSignal, absolute);
    if (aborted) {
      return Promise.resolve(aborted);
    }
    const content = this.files.get(absolute);
    if (!content) {
      return Promise.resolve(
        failure("not_found", `File not found: ${absolute}`, absolute),
      );
    }
    const text = Buffer.from(content).toString("utf8");
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === "") {
      lines.pop();
    }
    return Promise.resolve(success(lines.slice(0, options?.maxLines)));
  }

  readBinaryFile(
    path: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<Uint8Array, FileError>> {
    const absolute = this.resolve(path);
    const aborted = this.aborted<Uint8Array>(abortSignal, absolute);
    if (aborted) {
      return Promise.resolve(aborted);
    }
    const content = this.files.get(absolute);
    return Promise.resolve(
      content
        ? success(Uint8Array.from(content))
        : failure("not_found", `File not found: ${absolute}`, absolute),
    );
  }

  writeFile(
    path: string,
    _content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>> {
    const absolute = this.resolve(path);
    return Promise.resolve(
      this.aborted<void>(abortSignal, absolute) ??
        failure(
          "not_supported",
          "Pi API Storage filesystem is read-only",
          absolute,
        ),
    );
  }

  appendFile(
    path: string,
    _content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>> {
    return this.writeFile(path, _content, abortSignal);
  }

  fileInfo(
    path: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<FileInfo, FileError>> {
    const absolute = this.resolve(path);
    const aborted = this.aborted<FileInfo>(abortSignal, absolute);
    if (aborted) {
      return Promise.resolve(aborted);
    }
    const content = this.files.get(absolute);
    if (content) {
      return Promise.resolve(
        success({
          name: posix.basename(absolute),
          path: absolute,
          kind: "file",
          size: content.byteLength,
          mtimeMs: 0,
        }),
      );
    }
    if (this.directories.has(absolute)) {
      return Promise.resolve(
        success({
          name: posix.basename(absolute) || "/",
          path: absolute,
          kind: "directory",
          size: 0,
          mtimeMs: 0,
        }),
      );
    }
    return Promise.resolve(
      failure("not_found", `Path not found: ${absolute}`, absolute),
    );
  }

  listDir(
    path: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<FileInfo[], FileError>> {
    const absolute = this.resolve(path);
    const aborted = this.aborted<FileInfo[]>(abortSignal, absolute);
    if (aborted) {
      return Promise.resolve(aborted);
    }
    if (this.files.has(absolute)) {
      return Promise.resolve(
        failure("not_directory", `Not a directory: ${absolute}`, absolute),
      );
    }
    if (!this.directories.has(absolute)) {
      return Promise.resolve(
        failure("not_found", `Directory not found: ${absolute}`, absolute),
      );
    }
    const entries: FileInfo[] = [];
    for (const directory of this.directories) {
      if (directory !== absolute && posix.dirname(directory) === absolute) {
        entries.push({
          name: posix.basename(directory),
          path: directory,
          kind: "directory",
          size: 0,
          mtimeMs: 0,
        });
      }
    }
    for (const [file, content] of this.files) {
      if (posix.dirname(file) === absolute) {
        entries.push({
          name: posix.basename(file),
          path: file,
          kind: "file",
          size: content.byteLength,
          mtimeMs: 0,
        });
      }
    }
    entries.sort((left, right) => {
      return left.name.localeCompare(right.name);
    });
    return Promise.resolve(success(entries));
  }

  canonicalPath(
    path: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<string, FileError>> {
    const absolute = this.resolve(path);
    const aborted = this.aborted<string>(abortSignal, absolute);
    if (aborted) {
      return Promise.resolve(aborted);
    }
    return Promise.resolve(
      this.files.has(absolute) || this.directories.has(absolute)
        ? success(absolute)
        : failure("not_found", `Path not found: ${absolute}`, absolute),
    );
  }

  exists(
    path: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<boolean, FileError>> {
    const absolute = this.resolve(path);
    return Promise.resolve(
      this.aborted<boolean>(abortSignal, absolute) ??
        success(this.files.has(absolute) || this.directories.has(absolute)),
    );
  }

  createDir(
    path: string,
    options?: {
      readonly recursive?: boolean;
      readonly abortSignal?: AbortSignal;
    },
  ): Promise<Result<void, FileError>> {
    return this.writeFile(path, new Uint8Array(), options?.abortSignal);
  }

  remove(
    path: string,
    options?: {
      readonly recursive?: boolean;
      readonly force?: boolean;
      readonly abortSignal?: AbortSignal;
    },
  ): Promise<Result<void, FileError>> {
    return this.writeFile(path, new Uint8Array(), options?.abortSignal);
  }

  createTempDir(
    _prefix?: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<string, FileError>> {
    return Promise.resolve(
      this.aborted<string>(abortSignal) ??
        failure("not_supported", "Pi API Storage filesystem is read-only"),
    );
  }

  createTempFile(options?: {
    readonly prefix?: string;
    readonly suffix?: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<Result<string, FileError>> {
    return this.createTempDir(undefined, options?.abortSignal);
  }

  exec(
    _command: string,
    options?: {
      readonly cwd?: string;
      readonly env?: Record<string, string>;
      readonly inheritEnv?: boolean;
      readonly timeout?: number;
      readonly abortSignal?: AbortSignal;
      readonly onStdout?: (chunk: string) => void;
      readonly onStderr?: (chunk: string) => void;
    },
  ): Promise<
    Result<
      {
        readonly stdout: string;
        readonly stderr: string;
        readonly exitCode: number;
      },
      ExecutionError
    >
  > {
    return Promise.resolve(
      options?.abortSignal?.aborted
        ? executionFailure("aborted", "Operation aborted")
        : executionFailure(
            "shell_unavailable",
            "Shell execution requires Sandbox handoff",
          ),
    );
  }

  cleanup(): Promise<void> {
    return Promise.resolve();
  }
}

function versionKey(identity: StorageVersionIdentity): string {
  return JSON.stringify([identity.storageId, identity.versionId]);
}

function safeArchivePath(path: string): string {
  const withoutDot = path.replace(/^\.\//, "");
  const normalized = posix.normalize(withoutDot);
  if (
    posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`Invalid path in Pi Storage archive: ${path}`);
  }
  return normalized;
}

async function loadStorageVersions(
  get: <T>(computedValue: Computed<T>) => T,
  db: Db,
  identities: readonly StorageVersionIdentity[],
): Promise<ReadonlyMap<string, LoadedStorageVersion>> {
  const unique = new Map<string, StorageVersionIdentity>();
  for (const identity of identities) {
    unique.set(versionKey(identity), identity);
  }
  if (unique.size === 0) {
    return new Map();
  }
  const versionIds = [
    ...new Set(
      [...unique.values()].map(({ versionId }) => {
        return versionId;
      }),
    ),
  ];
  const rows = await db
    .select({
      storageId: storageVersions.storageId,
      versionId: storageVersions.id,
      s3Key: storageVersions.s3Key,
    })
    .from(storageVersions)
    .where(inArray(storageVersions.id, versionIds));
  const rowByKey = new Map(
    rows.map((row) => {
      return [versionKey(row), row];
    }),
  );
  const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
  const loaded = await Promise.all(
    [...unique.entries()].map(async ([key, identity]) => {
      const row = rowByKey.get(key);
      if (!row) {
        throw new Error(
          `Pi Storage version not found: ${identity.storageId}@${identity.versionId}`,
        );
      }
      const archive = await get(
        downloadS3Buffer(bucket, `${row.s3Key}/archive.tar.gz`),
      );
      return [
        key,
        {
          ...identity,
          files: extractBinaryFilesFromTarGz(archive).map((file) => {
            return { ...file, path: safeArchivePath(file.path) };
          }),
        },
      ] as const;
    }),
  );
  return new Map(loaded);
}

function instructionsMount(
  mounts: readonly PersistedStorageMount[],
): PersistedStorageMount | undefined {
  return mounts.find((mount) => {
    return mount.instructionsTargetFilename !== undefined;
  });
}

/** Load the exact Skill file view and Agent instructions pinned for a Pi run. */
export async function loadPiLaunchStorageResources(
  get: <T>(computedValue: Computed<T>) => T,
  db: Db,
  args: {
    readonly snapshot: RunSkillSnapshot;
    readonly persistedStorageMounts: readonly PersistedStorageMount[];
  },
): Promise<PiLaunchStorageResources> {
  const instructionMount = instructionsMount(args.persistedStorageMounts);
  const identities: StorageVersionIdentity[] = args.snapshot.entries.map(
    (entry) => {
      return { storageId: entry.storageId, versionId: entry.versionId };
    },
  );
  if (instructionMount?.version) {
    identities.push({
      storageId: instructionMount.storageId,
      versionId: instructionMount.version,
    });
  }
  const versions = await loadStorageVersions(get, db, identities);
  const files: StorageFile[] = [];
  for (const entry of args.snapshot.entries) {
    const version = versions.get(
      versionKey({
        storageId: entry.storageId,
        versionId: entry.versionId,
      }),
    );
    if (!version) {
      throw new Error(
        `Pi Skill Storage version not loaded: ${entry.storageId}@${entry.versionId}`,
      );
    }
    for (const file of version.files) {
      files.push({
        path: posix.join(entry.logicalDir, file.path),
        content: file.content,
      });
    }
  }

  let agentInstructions: string | null = null;
  if (
    instructionMount?.version &&
    instructionMount.instructionsTargetFilename
  ) {
    const version = versions.get(
      versionKey({
        storageId: instructionMount.storageId,
        versionId: instructionMount.version,
      }),
    );
    const instructionFile = version?.files.find((file) => {
      return file.path === instructionMount.instructionsTargetFilename;
    });
    agentInstructions = instructionFile?.content.toString("utf8") ?? null;
  }

  return { env: new StorageExecutionEnv(files), agentInstructions };
}
