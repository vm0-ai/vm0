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
