#!/usr/bin/env tsx

/**
 * Script to rebuild Drizzle snapshot chain
 *
 * This script rebuilds missing snapshots for migrations 0016-0088 by:
 * 1. Finding the git commit that added each migration
 * 2. Checking out that commit to get the schema at that time
 * 3. Running drizzle-kit to generate the snapshot
 * 4. Saving the snapshot with the correct migration number
 *
 * Usage:
 *   pnpm tsx scripts/rebuild-snapshots.ts [start-idx] [end-idx]
 *
 * Examples:
 *   pnpm tsx scripts/rebuild-snapshots.ts          # Rebuild all (16-88)
 *   pnpm tsx scripts/rebuild-snapshots.ts 16 20    # Rebuild 16-20
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const MIGRATIONS_DIR = path.join(__dirname, "../apps/web/src/db/migrations");
const META_DIR = path.join(MIGRATIONS_DIR, "meta");

interface MigrationInfo {
  idx: number;
  tag: string;
  sqlFile: string;
  commit?: string;
  commitDate?: string;
}

function exec(command: string, options?: { silent?: boolean }): string {
  try {
    return execSync(command, {
      encoding: "utf-8",
      stdio: options?.silent ? "pipe" : "inherit",
    });
  } catch (error) {
    if (options?.silent) {
      return "";
    }
    throw error;
  }
}

function findMigrationCommit(
  sqlFile: string,
): { commit: string; date: string } | null {
  const fullPath = `turbo/apps/web/src/db/migrations/${sqlFile}`;

  // Try current location first
  let result = exec(
    `git log --all --format="%H|%ci" --diff-filter=A -- "${fullPath}"`,
    { silent: true },
  );

  // Try old location (apps/api) if not found
  if (!result) {
    const oldPath = fullPath.replace("/apps/web/", "/apps/api/");
    result = exec(
      `git log --all --format="%H|%ci" --diff-filter=A -- "${oldPath}"`,
      { silent: true },
    );
  }

  if (!result) {
    return null;
  }

  const [commit, date] = result.trim().split("|");
  return { commit, date };
}

function getMigrationList(): MigrationInfo[] {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const migrations: MigrationInfo[] = [];

  for (const file of files) {
    const match = file.match(/^(\d{4})_(.+)\.sql$/);
    if (!match) continue;

    const idx = parseInt(match[1], 10);
    const tag = `${match[1]}_${match[2]}`;

    const commitInfo = findMigrationCommit(file);

    migrations.push({
      idx,
      tag,
      sqlFile: file,
      commit: commitInfo?.commit,
      commitDate: commitInfo?.date,
    });
  }

  return migrations;
}

function hasSnapshot(idx: number): boolean {
  const snapshotFile = path.join(
    META_DIR,
    `${String(idx).padStart(4, "0")}_snapshot.json`,
  );
  return fs.existsSync(snapshotFile);
}

function generateSnapshotAtCommit(migration: MigrationInfo): boolean {
  console.log(`\n${"=".repeat(80)}`);
  console.log(`Processing: ${migration.tag} (idx: ${migration.idx})`);
  console.log(`Commit: ${migration.commit}`);
  console.log(`Date: ${migration.commitDate}`);
  console.log("=".repeat(80));

  if (!migration.commit) {
    console.error(`❌ No commit found for ${migration.tag}`);
    return false;
  }

  // Save current branch
  const currentBranch = exec("git branch --show-current", {
    silent: true,
  }).trim();

  try {
    // Checkout the commit
    console.log(`📦 Checking out commit ${migration.commit}...`);
    exec(`git checkout ${migration.commit}`, { silent: true });

    // Generate snapshot using drizzle-kit
    console.log("🔧 Generating snapshot with drizzle-kit...");
    exec("cd turbo/apps/web && pnpm drizzle-kit generate");

    // Find the generated snapshot (should be the latest one)
    const metaFiles = fs
      .readdirSync(META_DIR)
      .filter((f) => f.endsWith("_snapshot.json"))
      .sort()
      .reverse();

    const latestSnapshot = metaFiles[0];
    if (!latestSnapshot) {
      console.error("❌ No snapshot generated");
      return false;
    }

    // Rename to correct migration index
    const expectedName = `${String(migration.idx).padStart(4, "0")}_snapshot.json`;
    const snapshotPath = path.join(META_DIR, latestSnapshot);
    const targetPath = path.join(META_DIR, expectedName);

    if (latestSnapshot !== expectedName) {
      fs.renameSync(snapshotPath, targetPath);
      console.log(`✅ Renamed ${latestSnapshot} → ${expectedName}`);
    }

    console.log(`✅ Successfully generated snapshot for ${migration.tag}`);
    return true;
  } catch (error) {
    console.error(`❌ Error generating snapshot: ${error}`);
    return false;
  } finally {
    // Return to original branch
    console.log(`🔙 Returning to ${currentBranch}...`);
    exec(`git checkout ${currentBranch}`, { silent: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  const startIdx = args[0] ? parseInt(args[0], 10) : 16;
  const endIdx = args[1] ? parseInt(args[1], 10) : 88;

  console.log("🔍 Scanning migrations...");
  const migrations = getMigrationList();

  console.log(`\nFound ${migrations.length} migrations total`);

  const missingSnapshots = migrations.filter(
    (m) => m.idx >= startIdx && m.idx <= endIdx && !hasSnapshot(m.idx),
  );

  console.log(`\nMissing snapshots: ${missingSnapshots.length}`);
  console.log(`Range: ${startIdx}-${endIdx}`);

  if (missingSnapshots.length === 0) {
    console.log("✅ All snapshots exist in the specified range!");
    return;
  }

  console.log("\n📋 Migrations to process:");
  for (const m of missingSnapshots) {
    console.log(
      `  ${m.idx}: ${m.tag} ${m.commit ? `(${m.commit.slice(0, 8)})` : "(no commit)"}`,
    );
  }

  console.log(
    "\n⚠️  This will checkout different commits. Make sure you have no uncommitted changes!",
  );
  console.log("Press Ctrl+C to cancel, or wait 5 seconds to continue...\n");

  // Wait 5 seconds
  execSync("sleep 5");

  const results = {
    success: 0,
    failed: 0,
    skipped: 0,
  };

  for (const migration of missingSnapshots) {
    if (!migration.commit) {
      console.log(`⏭️  Skipping ${migration.tag} (no commit found)`);
      results.skipped++;
      continue;
    }

    const success = generateSnapshotAtCommit(migration);
    if (success) {
      results.success++;
    } else {
      results.failed++;
    }
  }

  console.log("\n" + "=".repeat(80));
  console.log("📊 Summary");
  console.log("=".repeat(80));
  console.log(`✅ Success: ${results.success}`);
  console.log(`❌ Failed: ${results.failed}`);
  console.log(`⏭️  Skipped: ${results.skipped}`);
  console.log("=".repeat(80));
}

main();
