import * as fs from "fs";

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
