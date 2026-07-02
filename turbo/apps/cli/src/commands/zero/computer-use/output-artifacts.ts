import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const COMPUTER_USE_OUTPUT_DIR_MODE = 0o700;
const COMPUTER_USE_OUTPUT_FILE_MODE = 0o600;
const COMPUTER_USE_OUTPUT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_COMPUTER_USE_OUTPUT_DIR = path.join(
  tmpdir(),
  "vm0",
  "computer-use",
);

export function computerUseOutputDir(): string {
  const configured = process.env.VM0_COMPUTER_OUTPUT_DIR?.trim();
  return configured && configured.length > 0
    ? configured
    : DEFAULT_COMPUTER_USE_OUTPUT_DIR;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, {
    recursive: true,
    mode: COMPUTER_USE_OUTPUT_DIR_MODE,
  });
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(
      `Computer-use output path is not a directory: ${directory}`,
    );
  }
  await chmod(directory, COMPUTER_USE_OUTPUT_DIR_MODE);
}

async function removeStaleEntries(
  directory: string,
  cutoffMs: number,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    const stats = await lstat(entryPath).catch(() => {
      return null;
    });
    if (!stats) {
      continue;
    }
    if (entry.isDirectory() && !stats.isSymbolicLink()) {
      await removeStaleEntries(entryPath, cutoffMs);
      continue;
    }
    if (stats.mtimeMs < cutoffMs) {
      await rm(entryPath, { force: true, recursive: entry.isDirectory() });
    }
  }
}

async function prepareComputerUseOutputDir(): Promise<string> {
  const outputDir = computerUseOutputDir();
  await ensurePrivateDirectory(outputDir);
  await removeStaleEntries(outputDir, Date.now() - COMPUTER_USE_OUTPUT_TTL_MS);
  return outputDir;
}

async function ensureOutputPathDirectory(outputPath: string): Promise<void> {
  const outputDir = await prepareComputerUseOutputDir();
  const directory = path.dirname(outputPath);
  const relative = path.relative(outputDir, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Computer-use artifact path escapes output directory`);
  }

  let current = outputDir;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    await ensurePrivateDirectory(current);
  }
}

export async function writeComputerUseArtifact(
  outputPath: string,
  data: string | Buffer,
): Promise<void> {
  await ensureOutputPathDirectory(outputPath);
  const tempPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${process.pid.toString()}.${randomUUID()}.tmp`,
  );
  let moved = false;
  try {
    await writeFile(tempPath, data, {
      flag: "wx",
      mode: COMPUTER_USE_OUTPUT_FILE_MODE,
    });
    await chmod(tempPath, COMPUTER_USE_OUTPUT_FILE_MODE);
    await rename(tempPath, outputPath);
    moved = true;
    await chmod(outputPath, COMPUTER_USE_OUTPUT_FILE_MODE);
  } finally {
    if (!moved) {
      await rm(tempPath, { force: true });
    }
  }
}
