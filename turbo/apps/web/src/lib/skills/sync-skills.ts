/**
 * Skills sync orchestration
 *
 * Coordinates the full sync flow: freshness check via git refs,
 * tarball download/extraction, per-skill content hashing, S3 upload,
 * and database upserts for storages, storageVersions, and skills tables.
 */

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as tar from "tar";
import { eq } from "drizzle-orm";
import {
  SYSTEM_ORG_ID,
  VOLUME_ORG_USER_ID,
  getSkillStorageName,
  DEFAULT_SKILLS_OWNER,
  DEFAULT_SKILLS_REPO,
  DEFAULT_SKILLS_BRANCH,
  parseSkillFrontmatter,
  type SkillFrontmatter,
} from "@vm0/core";
import { fetchHeadCommitSha } from "./git-refs";
import { downloadAndExtractSkills, type ExtractedSkill } from "./tarball";
import {
  computeSystemSkillHash,
  type FileEntryWithHash,
} from "../storage/content-hash";
import { putS3Object } from "../s3/s3-client";
import { skills } from "../../db/schema/skill";
import { storages, storageVersions } from "../../db/schema/storage";
import { env } from "../../env";
import { logger } from "../logger";

const log = logger("skills:sync");

interface SyncResult {
  commitSha: string;
  /** Skills that were created or updated */
  synced: number;
  /** Skills unchanged (same version hash) */
  skipped: number;
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
    return { commitSha: headSha, synced: 0, skipped: 0, total: 0 };
  }

  // 3. Download and extract tarball
  const extractedSkills = await downloadAndExtractSkills();

  // 4. Sync each skill
  let synced = 0;
  let skipped = 0;

  for (const extracted of extractedSkills) {
    const wasUpdated = await syncSingleSkill(db, extracted, headSha);
    if (wasUpdated) {
      synced++;
    } else {
      skipped++;
    }
  }

  log.info("Sync completed", {
    commitSha: headSha,
    synced,
    skipped,
    total: extractedSkills.length,
  });

  return {
    commitSha: headSha,
    synced,
    skipped,
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
  const skillUrl = `https://github.com/${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}/tree/${DEFAULT_SKILLS_BRANCH}/${skillName}`;
  const fullPath = `${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}/tree/${DEFAULT_SKILLS_BRANCH}/${skillName}`;
  const storageName = getSkillStorageName(fullPath);

  // Parse SKILL.md frontmatter
  const skillMd = files.find((f) => f.path === "SKILL.md");
  const frontmatter: SkillFrontmatter = skillMd
    ? parseSkillFrontmatter(skillMd.content.toString("utf-8"))
    : {};

  // Compute file hashes for version hash
  const fileEntries: FileEntryWithHash[] = files.map((f) => ({
    path: f.path,
    hash: f.hash,
    size: f.size,
  }));
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
  const { archiveBuffer, manifestBuffer } = createSkillArchive(files);

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
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);

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
 * Create archive.tar.gz and manifest.json from in-memory files.
 *
 * Writes files to a temp directory, creates the tar with `tar.create()`,
 * then reads the result back as Buffers.
 */
function createSkillArchive(
  files: Array<{ path: string; content: Buffer; hash: string; size: number }>,
): { archiveBuffer: Buffer; manifestBuffer: Buffer } {
  const tmpDir = mkdtempSync(join(tmpdir(), "vm0-skill-"));

  try {
    // Write files to temp directory
    for (const file of files) {
      const filePath = join(tmpDir, file.path);
      const dir = join(filePath, "..");
      mkdirSync(dir, { recursive: true });
      writeFileSync(filePath, file.content);
    }

    // Create tar.gz synchronously
    const tarPath = join(tmpDir, "__archive.tar.gz");
    const filePaths = files.map((f) => f.path);

    tar.create(
      {
        gzip: true,
        file: tarPath,
        cwd: tmpDir,
        sync: true,
      },
      filePaths,
    );

    const archiveBuffer = readFileSync(tarPath);

    // Create manifest
    const manifest = {
      version: 1,
      files: files.map((f) => ({
        path: f.path,
        hash: f.hash,
        size: f.size,
      })),
      createdAt: new Date().toISOString(),
    };
    const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2));

    return { archiveBuffer, manifestBuffer };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
