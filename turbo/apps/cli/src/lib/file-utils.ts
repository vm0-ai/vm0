import * as fs from "fs";
import * as path from "path";
import type AdmZip from "adm-zip";

/**
 * Extract file paths from zip entries, normalizing path separators.
 */
export function getRemoteFilesFromZip(
  zipEntries: AdmZip.IZipEntry[],
): Set<string> {
  const remoteFiles = new Set<string>();
  for (const entry of zipEntries) {
    if (!entry.isDirectory) {
      remoteFiles.add(entry.entryName.replace(/\\/g, "/"));
    }
  }
  return remoteFiles;
}

/**
 * Recursively list all files in a directory, excluding specified directories.
 * Returns relative paths from the base directory.
 */
async function listLocalFiles(
  dir: string,
  excludeDirs: string[] = [".vm0"],
): Promise<string[]> {
  const files: string[] = [];

  async function walkDir(currentDir: string, relativePath: string = "") {
    const entries = await fs.promises.readdir(currentDir, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const entryRelativePath = relativePath
        ? path.join(relativePath, entry.name)
        : entry.name;

      if (entry.isDirectory()) {
        if (!excludeDirs.includes(entry.name)) {
          await walkDir(path.join(currentDir, entry.name), entryRelativePath);
        }
      } else {
        files.push(entryRelativePath);
      }
    }
  }

  await walkDir(dir);
  return files;
}

/**
 * Remove files that exist locally but not in remote.
 * Returns the number of files removed.
 */
export async function removeExtraFiles(
  dir: string,
  remoteFiles: Set<string>,
  excludeDirs: string[] = [".vm0"],
): Promise<number> {
  const localFiles = await listLocalFiles(dir, excludeDirs);
  let removedCount = 0;

  for (const localFile of localFiles) {
    // Normalize path separators for comparison
    const normalizedPath = localFile.replace(/\\/g, "/");
    if (!remoteFiles.has(normalizedPath)) {
      const fullPath = path.join(dir, localFile);
      await fs.promises.unlink(fullPath);
      removedCount++;
    }
  }

  // Clean up empty directories
  await removeEmptyDirs(dir, excludeDirs);

  return removedCount;
}

/**
 * Recursively remove empty directories, excluding specified directories.
 */
async function removeEmptyDirs(
  dir: string,
  excludeDirs: string[] = [".vm0"],
): Promise<boolean> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });

  let isEmpty = true;

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (excludeDirs.includes(entry.name)) {
        isEmpty = false;
      } else {
        const subDirEmpty = await removeEmptyDirs(fullPath, excludeDirs);
        if (subDirEmpty) {
          await fs.promises.rmdir(fullPath);
        } else {
          isEmpty = false;
        }
      }
    } else {
      isEmpty = false;
    }
  }

  return isEmpty;
}
