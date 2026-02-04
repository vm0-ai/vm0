import * as fs from "fs";
import * as path from "path";
import * as tar from "tar";

/**
 * Check if a directory exists and is empty (contains no files or subdirectories).
 * Returns: { exists: boolean, empty: boolean }
 * - Non-existent path: { exists: false, empty: true }
 * - Existing empty directory: { exists: true, empty: true }
 * - Existing non-empty directory: { exists: true, empty: false }
 * - Existing file (not directory): { exists: true, empty: false }
 */
export function checkDirectoryStatus(dirPath: string): {
  exists: boolean;
  empty: boolean;
} {
  if (!fs.existsSync(dirPath)) {
    return { exists: false, empty: true };
  }

  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) {
    // Path exists but is a file, not a directory
    return { exists: true, empty: false };
  }

  const entries = fs.readdirSync(dirPath);
  return { exists: true, empty: entries.length === 0 };
}

/**
 * Format bytes to human-readable format
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * Format relative time from ISO date string
 */
export function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);
  const diffWeek = Math.floor(diffDay / 7);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  if (diffHour < 24) return `${diffHour} hour${diffHour === 1 ? "" : "s"} ago`;
  if (diffDay < 7) return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
  return `${diffWeek} week${diffWeek === 1 ? "" : "s"} ago`;
}

/**
 * Filter function for tar.create to exclude .vm0 directory.
 * Paths come as "./.vm0" or ".vm0" depending on tar version.
 */
export function excludeVm0Filter(filePath: string): boolean {
  const shouldExclude =
    filePath === ".vm0" ||
    filePath.startsWith(".vm0/") ||
    filePath.startsWith("./.vm0");
  return !shouldExclude;
}

/**
 * List files in tar.gz buffer using streaming parser.
 */
export function listTarFiles(tarPath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const files: string[] = [];

    tar
      .list({
        file: tarPath,
        onReadEntry: (entry) => {
          if (entry.type === "File") {
            files.push(entry.path);
          }
        },
      })
      .then(() => resolve(files))
      .catch(reject);
  });
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
