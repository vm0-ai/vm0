import { createHash } from "node:crypto";
import { once } from "node:events";
import { createGzip } from "node:zlib";

import {
  DEFAULT_SKILLS_BRANCH,
  DEFAULT_SKILLS_OWNER,
  DEFAULT_SKILLS_REPO,
  resolveSkillRef,
} from "@vm0/core/github-url";
import {
  parseSkillFrontmatter,
  type SkillFrontmatter,
} from "@vm0/core/skill-frontmatter";
import {
  getSkillStorageName,
  SYSTEM_ORG_ID,
  VOLUME_ORG_USER_ID,
} from "@vm0/core/storage-names";
import { SEED_SKILLS } from "@vm0/core/zero-seed-skills";
import { skills } from "@vm0/db/schema/skill";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { command, computed, createStore, type Computed } from "ccstate";
import { eq, inArray, like } from "drizzle-orm";
import { pack, type Headers as TarHeaders, type Pack } from "tar-stream";
import { z } from "zod";

import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import {
  deleteS3Objects,
  listS3ObjectsUnderPrefix,
  putS3Object,
  s3ClientScopeForBucket,
  type S3ClientScope,
} from "../external/s3";
import { createDeferredPromise, settle, tapError } from "../utils";
import type { FileEntryWithHash } from "./storage-content-hash.service";
import { newStorageS3Location } from "./storage-s3-prefix.utils";

interface SyncSkillsResult {
  readonly commitSha: string;
  readonly synced: number;
  readonly skipped: number;
  readonly failed: number;
  readonly removed: number;
  readonly total: number;
}

interface ExtractedFile {
  readonly path: string;
  readonly hash: string;
  readonly size: number;
}

interface ExtractedSkill {
  readonly skillName: string;
  readonly files: readonly ExtractedFile[];
  readonly skillMdContent: Buffer;
  readonly archiveBuffer: Buffer;
}

interface SkillSyncContext {
  readonly skillName: string;
  readonly files: readonly ExtractedFile[];
  readonly url: string;
  readonly fullPath: string;
  readonly storageName: string;
  readonly frontmatter: SkillFrontmatter;
  readonly versionHash: string;
  readonly totalSize: number;
}

interface SkillArchiveUpload {
  readonly archiveSize: number;
  readonly s3Key: string;
}

interface GitTreeFile {
  readonly path: string;
  readonly sha: string;
  readonly size: number;
}

interface GitTreeSnapshot {
  readonly filesByPath: ReadonlyMap<string, GitTreeFile>;
  readonly skillFiles: ReadonlyMap<string, readonly GitTreeFile[]>;
}

interface StoredSkillSource {
  readonly url: string;
  readonly commitSha: string | null;
}

interface SkillTreeSyncPlan {
  readonly currentTree: GitTreeSnapshot;
  readonly changedSkills: ReadonlySet<string>;
  readonly sourceSkillNames: ReadonlySet<string>;
}

interface SkillArchiveBuilder {
  readonly archive: Pack;
  readonly archiveBuffer: Promise<Buffer>;
  readonly compressed: ReturnType<typeof createGzip>;
}

const log = logger("skills:sync");
const REPO_REFS_URL = `https://github.com/${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}.git/info/refs?service=git-upload-pack`;
const GITHUB_API_BASE = `https://api.github.com/repos/${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}`;
const RAW_CONTENT_BASE = `https://raw.githubusercontent.com/${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}`;
const GITHUB_API_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "vm0-api",
} as const;
const SYSTEM_SKILL_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const SYSTEM_SKILL_MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;

const gitTreeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(
    z.object({
      path: z.string().min(1),
      type: z.string(),
      sha: z.string().min(1),
      size: z.number().int().nonnegative().optional(),
    }),
  ),
});

function parseHeadRef(pktLineText: string, branch: string): string {
  const refSuffix = `refs/heads/${branch}`;
  const shaLength = 40;

  for (const line of pktLineText.split("\n")) {
    const refIndex = line.indexOf(refSuffix);
    if (refIndex === -1) {
      continue;
    }

    const shaEnd = refIndex - 1;
    const shaStart = shaEnd - shaLength;
    if (shaStart < 0) {
      continue;
    }

    const sha = line.substring(shaStart, shaEnd);
    if (/^[0-9a-f]{40}$/.test(sha)) {
      return sha;
    }
  }

  throw new Error(`refs/heads/${branch} not found in git refs`);
}

async function fetchHeadCommitSha(signal: AbortSignal): Promise<string> {
  const response = await fetch(REPO_REFS_URL, { signal });
  if (!response.ok) {
    throw new Error(`Failed to fetch git refs: ${response.status}`);
  }

  return parseHeadRef(await response.text(), DEFAULT_SKILLS_BRANCH);
}

async function fetchGitTree(
  commitSha: string,
  authorization: string | undefined,
  signal: AbortSignal,
): Promise<GitTreeSnapshot> {
  const response = await fetch(
    `${GITHUB_API_BASE}/git/trees/${commitSha}?recursive=1`,
    {
      headers: {
        ...GITHUB_API_HEADERS,
        ...(authorization ? { Authorization: authorization } : {}),
      },
      signal,
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch skills git tree: ${response.status}`);
  }
  const parsed = gitTreeSchema.parse(await response.json());
  if (parsed.truncated) {
    throw new Error("Skills git tree response was truncated");
  }

  const filesByPath = new Map<string, GitTreeFile>();
  const filesBySkill = new Map<string, GitTreeFile[]>();
  for (const entry of parsed.tree) {
    if (entry.type !== "blob" || entry.size === undefined) {
      continue;
    }
    const parts = entry.path.split("/");
    if (
      parts.length < 2 ||
      parts.some((part) => {
        return !part || part === "..";
      })
    ) {
      continue;
    }
    const file = { path: entry.path, sha: entry.sha, size: entry.size };
    filesByPath.set(file.path, file);
    const skillName = parts[0]!;
    const files = filesBySkill.get(skillName) ?? [];
    files.push(file);
    filesBySkill.set(skillName, files);
  }

  const skillFiles = new Map<string, readonly GitTreeFile[]>();
  for (const [skillName, files] of filesBySkill) {
    if (
      files.some((file) => {
        return file.path === `${skillName}/SKILL.md`;
      })
    ) {
      skillFiles.set(
        skillName,
        files.sort((left, right) => {
          return left.path.localeCompare(right.path);
        }),
      );
    }
  }
  return { filesByPath, skillFiles };
}

function changedSkillNames(
  previous: GitTreeSnapshot | undefined,
  current: GitTreeSnapshot,
): ReadonlySet<string> {
  if (!previous) {
    return new Set(current.skillFiles.keys());
  }
  const changed = new Set<string>();
  const paths = new Set([
    ...previous.filesByPath.keys(),
    ...current.filesByPath.keys(),
  ]);
  for (const path of paths) {
    if (
      previous.filesByPath.get(path)?.sha === current.filesByPath.get(path)?.sha
    ) {
      continue;
    }
    const [skillName] = path.split("/");
    if (skillName) {
      changed.add(skillName);
    }
  }
  return changed;
}

function computeSystemSkillHash(
  skillUrl: string,
  files: readonly FileEntryWithHash[],
): string {
  if (files.length === 0) {
    return createHash("sha256")
      .update(`system-skill:${skillUrl}\n`)
      .digest("hex");
  }

  const entries = files
    .map((file) => {
      return `${file.path}:${file.hash}`;
    })
    .sort();
  return createHash("sha256")
    .update(`system-skill:${skillUrl}\n${entries.join("\n")}`)
    .digest("hex");
}

function skillUrl(skillName: string): string {
  return `https://github.com/${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}/tree/${DEFAULT_SKILLS_BRANCH}/${skillName}`;
}

function buildSkillSyncContext(extracted: ExtractedSkill): SkillSyncContext {
  const skillName = extracted.skillName;
  const files = extracted.files;
  const url = skillUrl(skillName);
  const fullPath = `${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}/tree/${DEFAULT_SKILLS_BRANCH}/${skillName}`;
  const frontmatter: SkillFrontmatter = parseSkillFrontmatter(
    extracted.skillMdContent.toString("utf8"),
  );
  const fileEntries: FileEntryWithHash[] = files.map((file) => {
    return {
      path: file.path,
      hash: file.hash,
      size: file.size,
    };
  });
  const totalSize = files.reduce((sum, file) => {
    return sum + file.size;
  }, 0);

  return {
    skillName,
    files,
    url,
    fullPath,
    storageName: getSkillStorageName(fullPath),
    frontmatter,
    versionHash: computeSystemSkillHash(url, fileEntries),
    totalSize,
  };
}

function createSkillManifest(files: readonly ExtractedFile[]): Buffer {
  return Buffer.from(
    JSON.stringify(
      {
        version: 1,
        files: files.map((file) => {
          return {
            path: file.path,
            hash: file.hash,
            size: file.size,
          };
        }),
        createdAt: nowDate().toISOString(),
      },
      null,
      2,
    ),
  );
}

async function collectSkillArchive(
  compressed: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let archiveSize = 0;
  for await (const chunk of compressed) {
    signal.throwIfAborted();
    const buffer = Buffer.from(chunk);
    archiveSize += buffer.length;
    if (archiveSize > SYSTEM_SKILL_MAX_ARCHIVE_BYTES) {
      throw new Error(
        `Skill archive exceeds ${SYSTEM_SKILL_MAX_ARCHIVE_BYTES.toString()} bytes`,
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, archiveSize);
}

function startSkillArchive(signal: AbortSignal): SkillArchiveBuilder {
  const archive = pack();
  const compressed = createGzip({ level: 1 });
  archive.pipe(compressed);
  return {
    archive,
    archiveBuffer: collectSkillArchive(compressed, signal),
    compressed,
  };
}

function encodedRawFilePath(path: string): string {
  return path
    .split("/")
    .map((segment) => {
      return encodeURIComponent(segment);
    })
    .join("/");
}

async function writeSkillArchiveFile(
  builder: SkillArchiveBuilder,
  skillName: string,
  commitSha: string,
  file: GitTreeFile,
  signal: AbortSignal,
): Promise<{ readonly file: ExtractedFile; readonly skillMd?: Buffer }> {
  const response = await fetch(
    `${RAW_CONTENT_BASE}/${commitSha}/${encodedRawFilePath(file.path)}`,
    { signal },
  );
  if (!response.ok || !response.body) {
    throw new Error(`Failed to fetch skill file: ${response.status}`);
  }
  const relativePath = file.path.slice(skillName.length + 1);
  const header: TarHeaders = {
    name: relativePath,
    size: file.size,
    type: "file",
    mode: 0o644,
    mtime: new Date(0),
  };
  const archiveEntryComplete = createDeferredPromise<void>(signal);
  const archiveEntry: ReturnType<Pack["entry"]> = builder.archive.entry(
    header,
    (error) => {
      if (error) {
        archiveEntryComplete.reject(error);
      } else {
        archiveEntryComplete.resolve();
      }
    },
  );
  const hash = createHash("sha256");
  const skillMdChunks: Buffer[] = [];
  let bytesRead = 0;
  const reader = response.body.getReader();
  while (true) {
    signal.throwIfAborted();
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    const buffer = Buffer.from(chunk.value);
    bytesRead += buffer.length;
    hash.update(buffer);
    if (relativePath === "SKILL.md") {
      skillMdChunks.push(buffer);
    }
    if (!archiveEntry.write(buffer)) {
      await once(archiveEntry, "drain", { signal });
    }
  }
  archiveEntry.end();
  await archiveEntryComplete.promise;
  if (bytesRead !== file.size) {
    throw new Error("Skill file size did not match git tree metadata");
  }

  return {
    file: { path: relativePath, hash: hash.digest("hex"), size: bytesRead },
    ...(relativePath === "SKILL.md"
      ? { skillMd: Buffer.concat(skillMdChunks, bytesRead) }
      : {}),
  };
}

function normalizeArchiveError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function downloadSkillArchive(
  skillName: string,
  files: readonly GitTreeFile[],
  commitSha: string,
  signal: AbortSignal,
): Computed<Promise<ExtractedSkill>> {
  return computed(async (): Promise<ExtractedSkill> => {
    const totalSize = files.reduce((sum, file) => {
      return sum + file.size;
    }, 0);
    if (totalSize > SYSTEM_SKILL_MAX_TOTAL_BYTES) {
      throw new Error(
        `Skill content exceeds ${SYSTEM_SKILL_MAX_TOTAL_BYTES.toString()} bytes`,
      );
    }
    const builder = startSkillArchive(signal);
    const extractedFiles: ExtractedFile[] = [];
    let skillMdContent: Buffer | undefined;
    const extracted = await settle(
      (async () => {
        for (const file of files) {
          const result = await writeSkillArchiveFile(
            builder,
            skillName,
            commitSha,
            file,
            signal,
          );
          extractedFiles.push(result.file);
          skillMdContent = result.skillMd ?? skillMdContent;
        }
        builder.archive.finalize();
        const archiveBuffer = await builder.archiveBuffer;
        if (!skillMdContent) {
          throw new Error("Skill archive is missing SKILL.md");
        }
        return {
          skillName,
          files: extractedFiles,
          skillMdContent,
          archiveBuffer,
        };
      })(),
      signal,
    );
    if (!extracted.ok) {
      const error = normalizeArchiveError(extracted.error);
      builder.archive.destroy();
      builder.compressed.destroy(error);
      await settle(builder.archiveBuffer);
      throw error;
    }
    return extracted.value;
  });
}

async function hasCurrentSkillVersion(
  args: {
    readonly db: Db;
    readonly url: string;
    readonly versionHash: string;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const [existingSkill] = await args.db
    .select({ versionHash: skills.versionHash })
    .from(skills)
    .where(eq(skills.url, args.url))
    .limit(1);
  signal.throwIfAborted();

  if (existingSkill?.versionHash !== args.versionHash) {
    return false;
  }
  return true;
}

function uploadSkillArchive(
  context: SkillSyncContext,
  extracted: ExtractedSkill,
  s3Prefix: string,
  signal: AbortSignal,
  s3ClientScope: S3ClientScope,
): Computed<Promise<SkillArchiveUpload>> {
  return computed(async (get): Promise<SkillArchiveUpload> => {
    const bucketName = env("R2_USER_STORAGES_BUCKET_NAME");
    const s3Key = `${s3Prefix}/${context.versionHash}`;
    const manifestBuffer = createSkillManifest(context.files);

    await Promise.all([
      get(
        putS3Object(
          bucketName,
          `${s3Key}/archive.tar.gz`,
          extracted.archiveBuffer,
          "application/gzip",
          { signal, clientScope: s3ClientScope },
        ),
      ),
      get(
        putS3Object(
          bucketName,
          `${s3Key}/manifest.json`,
          manifestBuffer,
          "application/json",
          { clientScope: s3ClientScope },
        ),
      ),
    ]);
    signal.throwIfAborted();

    return {
      archiveSize: extracted.archiveBuffer.length,
      s3Key,
    };
  });
}

async function upsertSkillStorage(
  args: {
    readonly db: Db;
    readonly context: SkillSyncContext;
    readonly timestamp: Date;
  },
  signal: AbortSignal,
): Promise<{ readonly id: string; readonly s3Prefix: string }> {
  const location = newStorageS3Location(SYSTEM_ORG_ID);
  const [storage] = await args.db
    .insert(storages)
    .values({
      id: location.storageId,
      orgId: SYSTEM_ORG_ID,
      userId: VOLUME_ORG_USER_ID,
      name: args.context.storageName,
      s3Prefix: location.s3Prefix,
      size: args.context.totalSize,
      fileCount: args.context.files.length,
    })
    .onConflictDoUpdate({
      target: [storages.orgId, storages.userId, storages.name],
      set: {
        size: args.context.totalSize,
        fileCount: args.context.files.length,
        updatedAt: args.timestamp,
      },
    })
    .returning({ id: storages.id, s3Prefix: storages.s3Prefix });
  signal.throwIfAborted();

  if (!storage) {
    throw new Error(
      `Failed to create storage for skill ${args.context.skillName}`,
    );
  }

  return storage;
}

async function insertSkillStorageVersion(
  args: {
    readonly db: Db;
    readonly storageId: string;
    readonly context: SkillSyncContext;
    readonly upload: SkillArchiveUpload;
    readonly commitSha: string;
  },
  signal: AbortSignal,
): Promise<void> {
  await args.db
    .insert(storageVersions)
    .values({
      id: args.context.versionHash,
      storageId: args.storageId,
      s3Key: args.upload.s3Key,
      size: args.context.totalSize,
      archiveSize: args.upload.archiveSize,
      fileCount: args.context.files.length,
      message: `Synced from ${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}@${args.commitSha.slice(0, 7)}`,
      createdBy: "system",
    })
    .onConflictDoUpdate({
      target: storageVersions.id,
      set: { archiveSize: args.upload.archiveSize },
    });
  signal.throwIfAborted();
}

async function updateSkillStorageHead(
  args: {
    readonly db: Db;
    readonly storageId: string;
    readonly context: SkillSyncContext;
    readonly timestamp: Date;
  },
  signal: AbortSignal,
): Promise<void> {
  await args.db
    .update(storages)
    .set({
      headVersionId: args.context.versionHash,
      size: args.context.totalSize,
      fileCount: args.context.files.length,
      updatedAt: args.timestamp,
    })
    .where(eq(storages.id, args.storageId));
  signal.throwIfAborted();
}

async function upsertSkillRecord(
  args: {
    readonly db: Db;
    readonly storageId: string;
    readonly context: SkillSyncContext;
    readonly upload: SkillArchiveUpload;
    readonly timestamp: Date;
  },
  signal: AbortSignal,
): Promise<void> {
  const displayName = args.context.frontmatter.name ?? args.context.skillName;

  await args.db
    .insert(skills)
    .values({
      url: args.context.url,
      name: displayName,
      fullPath: args.context.fullPath,
      storageId: args.storageId,
      versionHash: args.context.versionHash,
      commitSha: null,
      frontmatter: args.context.frontmatter,
      s3Key: args.upload.s3Key,
      size: args.context.totalSize,
      fileCount: args.context.files.length,
      syncedAt: args.timestamp,
    })
    .onConflictDoUpdate({
      target: skills.url,
      set: {
        name: displayName,
        fullPath: args.context.fullPath,
        storageId: args.storageId,
        versionHash: args.context.versionHash,
        commitSha: null,
        frontmatter: args.context.frontmatter,
        s3Key: args.upload.s3Key,
        size: args.context.totalSize,
        fileCount: args.context.files.length,
        syncedAt: args.timestamp,
        updatedAt: args.timestamp,
      },
    });
  signal.throwIfAborted();
}

function syncSingleSkill(
  db: Db,
  extracted: ExtractedSkill,
  commitSha: string,
  signal: AbortSignal,
  s3ClientScope: S3ClientScope,
): Computed<Promise<boolean>> {
  return computed(async (get): Promise<boolean> => {
    const context = buildSkillSyncContext(extracted);

    if (
      await hasCurrentSkillVersion(
        {
          db,
          url: context.url,
          versionHash: context.versionHash,
        },
        signal,
      )
    ) {
      return false;
    }

    const timestamp = nowDate();
    // Upsert the storage row first: objects must land under the row's stored
    // prefix, which an existing row keeps from its creation time.
    const storage = await upsertSkillStorage(
      {
        db,
        context,
        timestamp,
      },
      signal,
    );
    const storageId = storage.id;
    const upload = await get(
      uploadSkillArchive(
        context,
        extracted,
        storage.s3Prefix,
        signal,
        s3ClientScope,
      ),
    );
    await insertSkillStorageVersion(
      {
        db,
        storageId,
        context,
        upload,
        commitSha,
      },
      signal,
    );
    await updateSkillStorageHead(
      {
        db,
        storageId,
        context,
        timestamp,
      },
      signal,
    );
    await upsertSkillRecord(
      {
        db,
        storageId,
        context,
        upload,
        timestamp,
      },
      signal,
    );

    log.debug("Synced skill", {
      skillName: context.skillName,
      versionHash: context.versionHash.slice(0, 8),
    });
    return true;
  });
}

function removeOrphanedSkills(
  db: Db,
  sourceSkillNames: ReadonlySet<string>,
  signal: AbortSignal,
  s3ClientScope: S3ClientScope,
): Computed<Promise<number>> {
  return computed(async (get): Promise<number> => {
    const sourceUrls = new Set(
      [...sourceSkillNames].map((skillName) => {
        return skillUrl(skillName);
      }),
    );
    const urlPrefix = `https://github.com/${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}/tree/${DEFAULT_SKILLS_BRANCH}/`;
    const existingSkills = await db
      .select({ id: skills.id, url: skills.url, storageId: skills.storageId })
      .from(skills)
      .where(like(skills.url, `${urlPrefix}%`));
    signal.throwIfAborted();

    const orphans = existingSkills.filter((skill) => {
      return !sourceUrls.has(skill.url);
    });
    if (orphans.length === 0) {
      return 0;
    }

    const orphanIds = orphans.map((skill) => {
      return skill.id;
    });
    const orphanStorageIds = orphans
      .map((skill) => {
        return skill.storageId;
      })
      .filter((id): id is string => {
        return id !== null;
      });

    const orphanStorages =
      orphanStorageIds.length > 0
        ? await db
            .select({ id: storages.id, s3Prefix: storages.s3Prefix })
            .from(storages)
            .where(inArray(storages.id, orphanStorageIds))
        : [];
    signal.throwIfAborted();

    await db.delete(skills).where(inArray(skills.id, orphanIds));
    signal.throwIfAborted();

    if (orphanStorageIds.length > 0) {
      await db.delete(storages).where(inArray(storages.id, orphanStorageIds));
      signal.throwIfAborted();
    }

    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    for (const storage of orphanStorages) {
      await tapError(
        (async () => {
          const objects = await get(
            listS3ObjectsUnderPrefix(bucket, storage.s3Prefix, s3ClientScope),
          );
          signal.throwIfAborted();
          if (objects.length > 0) {
            await get(
              deleteS3Objects(
                bucket,
                objects.map((object) => {
                  return object.key;
                }),
                s3ClientScope,
              ),
            );
            signal.throwIfAborted();
          }
        })(),
        (error) => {
          log.warn("Failed to clean up S3 objects for removed skill", {
            s3Prefix: storage.s3Prefix,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      );
    }

    log.debug("Removed orphaned skills", {
      removed: orphans.length,
      skillUrls: orphans.map((skill) => {
        return skill.url;
      }),
    });
    return orphans.length;
  });
}

function validateSeedSkills(sourceSkillNames: ReadonlySet<string>): void {
  const missingSkills = SEED_SKILLS.filter((name) => {
    return !sourceSkillNames.has(name);
  });

  if (missingSkills.length > 0) {
    log.error("SEED_SKILLS references skills not found in repository", {
      missingSkills: missingSkills.map((name) => {
        return resolveSkillRef(name);
      }),
    });
  }
}

function isUsableBaseCommitSha(commitSha: string): boolean {
  return /^[0-9a-f]{40}$/.test(commitSha) && commitSha !== "0".repeat(40);
}

async function buildSkillTreeSyncPlan(
  existing: readonly StoredSkillSource[],
  headSha: string,
  authorization: string | undefined,
  signal: AbortSignal,
): Promise<SkillTreeSyncPlan> {
  const currentTree = await fetchGitTree(headSha, authorization, signal);
  signal.throwIfAborted();
  const baseCommitShas = new Set(
    existing.flatMap((skill) => {
      return skill.commitSha && isUsableBaseCommitSha(skill.commitSha)
        ? [skill.commitSha]
        : [];
    }),
  );
  const [baseCommitSha] = baseCommitShas;
  const previousTreeResult =
    baseCommitShas.size === 1 && baseCommitSha
      ? await settle(fetchGitTree(baseCommitSha, authorization, signal), signal)
      : undefined;
  if (previousTreeResult && !previousTreeResult.ok) {
    log.warn("Failed to fetch previous skills tree; checking all skills", {
      commitSha: baseCommitSha,
      error:
        previousTreeResult.error instanceof Error
          ? previousTreeResult.error.message
          : String(previousTreeResult.error),
    });
  }
  const previousTree = previousTreeResult?.ok
    ? previousTreeResult.value
    : undefined;
  const changedSkills = new Set(changedSkillNames(previousTree, currentTree));
  const existingUrls = new Set(
    existing.map((skill) => {
      return skill.url;
    }),
  );
  for (const skillName of currentTree.skillFiles.keys()) {
    if (!existingUrls.has(skillUrl(skillName))) {
      changedSkills.add(skillName);
    }
  }
  return {
    currentTree,
    changedSkills,
    sourceSkillNames: new Set(currentTree.skillFiles.keys()),
  };
}

function githubApiAuthorization(): string | undefined {
  const clientId = optionalEnv("GH_OAUTH_CLIENT_ID");
  const clientSecret = optionalEnv("GH_OAUTH_CLIENT_SECRET");
  if (!clientId && !clientSecret) {
    return undefined;
  }
  if (!clientId || !clientSecret) {
    throw new Error("GitHub OAuth credentials must be configured together");
  }
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

async function markSkillsSyncComplete(
  db: Db,
  sourceSkillNames: ReadonlySet<string>,
  commitSha: string,
  signal: AbortSignal,
): Promise<void> {
  const sourceUrls = [...sourceSkillNames].map((skillName) => {
    return skillUrl(skillName);
  });
  if (sourceUrls.length === 0) {
    return;
  }
  await db
    .update(skills)
    .set({ commitSha, updatedAt: nowDate() })
    .where(inArray(skills.url, sourceUrls));
  signal.throwIfAborted();
}

type ChangedSkillSyncOutcome = "failed" | "skipped" | "synced";

interface SyncChangedSkillArgs {
  readonly db: Db;
  readonly skillName: string;
  readonly files: readonly GitTreeFile[];
  readonly headSha: string;
  readonly s3ClientScope: S3ClientScope;
}

async function syncChangedSkill(
  args: SyncChangedSkillArgs,
  signal: AbortSignal,
): Promise<ChangedSkillSyncOutcome> {
  // Keep each skill's computation graph short-lived while reusing the request's
  // S3 client. This releases completed archive state without accumulating
  // clients and their connection state inside the Worker isolate.
  const skillStore = createStore();
  const downloaded = await settle(
    skillStore.get(
      downloadSkillArchive(args.skillName, args.files, args.headSha, signal),
    ),
    signal,
  );
  signal.throwIfAborted();
  if (!downloaded.ok) {
    log.warn("Skipping skill due to sync error", {
      skillName: args.skillName,
      error:
        downloaded.error instanceof Error
          ? downloaded.error.message
          : String(downloaded.error),
    });
    return "failed";
  }

  const result = await settle(
    skillStore.get(
      syncSingleSkill(
        args.db,
        downloaded.value,
        args.headSha,
        signal,
        args.s3ClientScope,
      ),
    ),
    signal,
  );
  signal.throwIfAborted();
  if (!result.ok) {
    log.warn("Skipping skill due to sync error", {
      skillName: args.skillName,
      error:
        result.error instanceof Error
          ? result.error.message
          : String(result.error),
    });
    return "failed";
  }
  return result.value ? "synced" : "skipped";
}

export const syncSkills$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<SyncSkillsResult> => {
    const db = set(writeDb$);
    const headSha = await fetchHeadCommitSha(signal);
    signal.throwIfAborted();

    const urlPrefix = `https://github.com/${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}/tree/${DEFAULT_SKILLS_BRANCH}/`;
    const existing = await db
      .select({ url: skills.url, commitSha: skills.commitSha })
      .from(skills)
      .where(like(skills.url, `${urlPrefix}%`));
    signal.throwIfAborted();

    if (
      existing.length > 0 &&
      existing.every((skill) => {
        return skill.commitSha === headSha;
      })
    ) {
      return {
        commitSha: headSha,
        synced: 0,
        skipped: 0,
        failed: 0,
        removed: 0,
        total: 0,
      };
    }

    const authorization = githubApiAuthorization();
    const { currentTree, changedSkills, sourceSkillNames } =
      await buildSkillTreeSyncPlan(existing, headSha, authorization, signal);
    const s3ClientScope = get(
      s3ClientScopeForBucket(env("R2_USER_STORAGES_BUCKET_NAME")),
    );

    let synced = 0;
    let skipped = 0;
    let failed = 0;

    for (const [skillName, files] of currentTree.skillFiles) {
      if (!changedSkills.has(skillName)) {
        skipped++;
        continue;
      }

      const outcome = await syncChangedSkill(
        {
          db,
          skillName,
          files,
          headSha,
          s3ClientScope,
        },
        signal,
      );
      if (outcome === "failed") {
        failed++;
      } else if (outcome === "synced") {
        synced++;
      } else {
        skipped++;
      }
    }

    const removed = await get(
      removeOrphanedSkills(db, sourceSkillNames, signal, s3ClientScope),
    );
    signal.throwIfAborted();
    validateSeedSkills(sourceSkillNames);
    if (failed === 0) {
      await markSkillsSyncComplete(db, sourceSkillNames, headSha, signal);
    }

    log.debug("Skills sync completed", {
      commitSha: headSha,
      synced,
      skipped,
      failed,
      removed,
      total: sourceSkillNames.size,
    });

    return {
      commitSha: headSha,
      synced,
      skipped,
      failed,
      removed,
      total: sourceSkillNames.size,
    };
  },
);
