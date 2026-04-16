/**
 * Skills sync orchestration
 *
 * Coordinates the full sync flow: freshness check via git refs,
 * tarball download/extraction, per-skill content hashing, S3 upload,
 * and database upserts for storages, storageVersions, and skills tables.
 */

import { mkdirSync, rmSync } from "node:fs";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as tar from "tar";
import { eq, inArray, like } from "drizzle-orm";
import {
  SYSTEM_ORG_ID,
  VOLUME_ORG_USER_ID,
  getSkillStorageName,
  DEFAULT_SKILLS_OWNER,
  DEFAULT_SKILLS_REPO,
  DEFAULT_SKILLS_BRANCH,
  parseSkillFrontmatter,
  resolveSkillRef,
  type SkillFrontmatter,
} from "@vm0/core";
import { fetchHeadCommitSha } from "./git-refs";
import { downloadAndExtractSkills, type ExtractedSkill } from "./tarball";
import { computeSystemSkillHash } from "./content-hash";
import type { FileEntryWithHash } from "../../infra/storage/content-hash";
import {
  putS3Object,
  listS3Objects,
  deleteS3Objects,
} from "../../infra/s3/s3-client";
import { skills } from "../../../db/schema/skill";
import { storages, storageVersions } from "../../../db/schema/storage";
import { env } from "../../../env";
import { logger } from "../../shared/logger";
import { SEED_SKILLS } from "../seed-skills";

const log = logger("skills:sync");

interface SyncResult {
  commitSha: string;
  /** Skills that were created or updated */
  synced: number;
  /** Skills unchanged (same version hash) */
  skipped: number;
  /** Skills that failed to sync (e.g. bad frontmatter) */
  failed: number;
  /** Skills removed because they no longer exist in source repo */
  removed: number;
  /** Total skills found in tarball */
  total: number;
}

/**
 * Sync all official skills from the vm0-skills repository.
 *
 * 1. Fetch HEAD commit SHA via git smart HTTP protocol
 * 2. Compare with stored commit SHA — skip if unchanged
 * 3. Download and extract tarball
 * 4. For each skill: compute hash, compare, upload to S3, upsert DB
 */
export async function syncSkills(): Promise<SyncResult> {
  const db = globalThis.services.db;

  // 1. Fetch current HEAD
  const headSha = await fetchHeadCommitSha();

  // 2. Check stored commit SHA from any existing skill row
  const [existing] = await db
    .select({ commitSha: skills.commitSha })
    .from(skills)
    .limit(1);

  if (existing?.commitSha === headSha) {
    return {
      commitSha: headSha,
      synced: 0,
      skipped: 0,
      failed: 0,
      removed: 0,
      total: 0,
    };
  }

  // 3. Download and extract tarball
  const extractedSkills = await downloadAndExtractSkills();

  // 4. Sync each skill concurrently (batched to avoid exhausting DB pool / S3)
  const BATCH_SIZE = 5;
  let synced = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < extractedSkills.length; i += BATCH_SIZE) {
    const batch = extractedSkills.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((extracted) => {
        return syncSingleSkill(db, extracted, headSha);
      }),
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j]!;
      if (result.status === "fulfilled") {
        if (result.value) {
          synced++;
        } else {
          skipped++;
        }
      } else {
        failed++;
        log.warn("Skipping skill due to sync error", {
          skillName: batch[j]!.skillName,
          error:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        });
      }
    }
  }

  // 5. Remove orphaned skills (in DB but no longer in tarball)
  const removed = await removeOrphanedSkills(db, extractedSkills);

  // 6. Validate SEED_SKILLS against tarball
  validateSeedSkills(extractedSkills);

  log.info("Sync completed", {
    commitSha: headSha,
    synced,
    skipped,
    failed,
    removed,
    total: extractedSkills.length,
  });

  return {
    commitSha: headSha,
    synced,
    skipped,
    failed,
    removed,
    total: extractedSkills.length,
  };
}

/**
 * Sync a single skill: compute hash, compare with DB, upload to S3 if changed,
 * and upsert all DB records.
 *
 * @returns true if the skill was created or updated, false if skipped
 */
async function syncSingleSkill(
  db: typeof globalThis.services.db,
  extracted: ExtractedSkill,
  commitSha: string,
): Promise<boolean> {
  const { skillName, files } = extracted;
  const skillUrl = buildSkillUrl(skillName);
  const fullPath = `${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}/tree/${DEFAULT_SKILLS_BRANCH}/${skillName}`;
  const storageName = getSkillStorageName(fullPath);

  // Parse SKILL.md frontmatter
  const skillMd = files.find((f) => {
    return f.path === "SKILL.md";
  });
  const frontmatter: SkillFrontmatter = skillMd
    ? parseSkillFrontmatter(skillMd.content.toString("utf-8"))
    : {};

  // Compute file hashes for version hash
  const fileEntries: FileEntryWithHash[] = files.map((f) => {
    return {
      path: f.path,
      hash: f.hash,
      size: f.size,
    };
  });
  const versionHash = computeSystemSkillHash(skillUrl, fileEntries);

  // Check if skill already exists with same version hash
  const [existingSkill] = await db
    .select({ versionHash: skills.versionHash })
    .from(skills)
    .where(eq(skills.url, skillUrl))
    .limit(1);

  if (existingSkill?.versionHash === versionHash) {
    // Content unchanged — just update commitSha
    await db
      .update(skills)
      .set({ commitSha, updatedAt: new Date() })
      .where(eq(skills.url, skillUrl));
    return false;
  }

  // Create archive.tar.gz and manifest.json
  const { archiveBuffer, manifestBuffer } = await createSkillArchive(files);

  // Upload to S3
  const bucketName = env().R2_USER_STORAGES_BUCKET_NAME;
  const s3Prefix = `${SYSTEM_ORG_ID}/volume/${storageName}`;
  const s3Key = `${s3Prefix}/${versionHash}`;

  await Promise.all([
    putS3Object(
      bucketName,
      `${s3Key}/archive.tar.gz`,
      archiveBuffer,
      "application/gzip",
    ),
    putS3Object(
      bucketName,
      `${s3Key}/manifest.json`,
      manifestBuffer,
      "application/json",
    ),
  ]);

  // Upsert storages record
  const [storage] = await db
    .insert(storages)
    .values({
      orgId: SYSTEM_ORG_ID,
      userId: VOLUME_ORG_USER_ID,
      name: storageName,
      type: "volume",
      s3Prefix,
      size: archiveBuffer.length,
      fileCount: files.length,
    })
    .onConflictDoUpdate({
      target: [storages.orgId, storages.userId, storages.name, storages.type],
      set: {
        size: archiveBuffer.length,
        fileCount: files.length,
        updatedAt: new Date(),
      },
    })
    .returning({ id: storages.id });

  const storageId = storage!.id;

  // Upsert storageVersions record (content-addressed by versionHash)
  await db
    .insert(storageVersions)
    .values({
      id: versionHash,
      storageId,
      s3Key,
      size: archiveBuffer.length,
      fileCount: files.length,
      message: `Synced from ${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}@${commitSha.slice(0, 7)}`,
      createdBy: "system",
    })
    .onConflictDoNothing();

  // Update storage HEAD pointer
  await db
    .update(storages)
    .set({
      headVersionId: versionHash,
      size: archiveBuffer.length,
      fileCount: files.length,
      updatedAt: new Date(),
    })
    .where(eq(storages.id, storageId));

  // Upsert skills record
  const displayName = frontmatter.name || skillName;
  const totalSize = files.reduce((sum, f) => {
    return sum + f.size;
  }, 0);

  await db
    .insert(skills)
    .values({
      url: skillUrl,
      name: displayName,
      fullPath,
      storageId,
      versionHash,
      commitSha,
      frontmatter,
      s3Key,
      size: totalSize,
      fileCount: files.length,
      syncedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: skills.url,
      set: {
        name: displayName,
        fullPath,
        storageId,
        versionHash,
        commitSha,
        frontmatter,
        s3Key,
        size: totalSize,
        fileCount: files.length,
        syncedAt: new Date(),
        updatedAt: new Date(),
      },
    });

  log.debug("Synced skill", {
    skillName,
    versionHash: versionHash.slice(0, 8),
  });
  return true;
}

/**
 * Build the canonical URL for an official skill.
 */
function buildSkillUrl(skillName: string): string {
  return `https://github.com/${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}/tree/${DEFAULT_SKILLS_BRANCH}/${skillName}`;
}

/**
 * Remove skills from the database that no longer exist in the source repository.
 *
 * Deletion order: skills → storages (cascades to storageVersions) → S3 objects.
 * S3 cleanup is best-effort — errors are logged but do not block the sync.
 *
 * @returns Number of orphaned skills removed
 */
async function removeOrphanedSkills(
  db: typeof globalThis.services.db,
  extractedSkills: ExtractedSkill[],
): Promise<number> {
  const tarballUrls = new Set(
    extractedSkills.map((e) => {
      return buildSkillUrl(e.skillName);
    }),
  );

  // Find all official skills in DB
  const urlPrefix = `https://github.com/${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}/tree/${DEFAULT_SKILLS_BRANCH}/`;
  const existingSkills = await db
    .select({ id: skills.id, url: skills.url, storageId: skills.storageId })
    .from(skills)
    .where(like(skills.url, `${urlPrefix}%`));

  const orphans = existingSkills.filter((s) => {
    return !tarballUrls.has(s.url);
  });
  if (orphans.length === 0) return 0;

  const orphanIds = orphans.map((o) => {
    return o.id;
  });
  const orphanStorageIds = orphans
    .map((o) => {
      return o.storageId;
    })
    .filter((id): id is string => {
      return id !== null;
    });

  // Get S3 prefixes before deleting DB records
  let orphanStorages: { id: string; s3Prefix: string }[] = [];
  if (orphanStorageIds.length > 0) {
    orphanStorages = await db
      .select({ id: storages.id, s3Prefix: storages.s3Prefix })
      .from(storages)
      .where(inArray(storages.id, orphanStorageIds));
  }

  // Delete skills first (FK to storages is ON DELETE NO ACTION)
  await db.delete(skills).where(inArray(skills.id, orphanIds));

  // Delete storages (cascades to storageVersions)
  if (orphanStorageIds.length > 0) {
    await db.delete(storages).where(inArray(storages.id, orphanStorageIds));
  }

  // Best-effort S3 cleanup
  const bucketName = env().R2_USER_STORAGES_BUCKET_NAME;
  for (const storage of orphanStorages) {
    try {
      const objects = await listS3Objects(bucketName, storage.s3Prefix);
      if (objects.length > 0) {
        await deleteS3Objects(
          bucketName,
          objects.map((o) => {
            return o.key;
          }),
        );
      }
    } catch (error) {
      log.warn("Failed to clean up S3 objects for removed skill", {
        s3Prefix: storage.s3Prefix,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  log.info("Removed orphaned skills", {
    removed: orphans.length,
    skillUrls: orphans.map((o) => {
      return o.url;
    }),
  });

  return orphans.length;
}

/**
 * Validate that all SEED_SKILLS entries exist in the current tarball.
 * Emits log.error for any seed skills that reference deleted skills.
 */
function validateSeedSkills(extractedSkills: ExtractedSkill[]): void {
  const tarballNames = new Set(
    extractedSkills.map((e) => {
      return e.skillName;
    }),
  );
  const missingSkills = SEED_SKILLS.filter((name) => {
    return !tarballNames.has(name);
  });

  if (missingSkills.length > 0) {
    log.error("SEED_SKILLS references skills not found in repository", {
      missingSkills: missingSkills.map((name) => {
        return resolveSkillRef(name);
      }),
    });
  }
}

/**
 * Create archive.tar.gz and manifest.json from in-memory files.
 *
 * Writes files to a temp directory, creates the tar with `tar.create()`,
 * then reads the result back as Buffers.
 */
async function createSkillArchive(
  files: Array<{ path: string; content: Buffer; hash: string; size: number }>,
): Promise<{ archiveBuffer: Buffer; manifestBuffer: Buffer }> {
  const tmpDir = await mkdtemp(join(tmpdir(), "vm0-skill-"));

  try {
    // Write files to temp directory
    await Promise.all(
      files.map((file) => {
        const filePath = join(tmpDir, file.path);
        const dir = join(filePath, "..");
        mkdirSync(dir, { recursive: true });
        return writeFile(filePath, file.content);
      }),
    );

    // Create tar.gz asynchronously
    const tarPath = join(tmpDir, "__archive.tar.gz");
    const filePaths = files.map((f) => {
      return f.path;
    });

    await tar.create(
      {
        gzip: true,
        file: tarPath,
        cwd: tmpDir,
      },
      filePaths,
    );

    const archiveBuffer = await readFile(tarPath);

    // Create manifest
    const manifest = {
      version: 1,
      files: files.map((f) => {
        return {
          path: f.path,
          hash: f.hash,
          size: f.size,
        };
      }),
      createdAt: new Date().toISOString(),
    };
    const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2));

    return { archiveBuffer, manifestBuffer };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
