import { Command } from "commander";
import chalk from "chalk";
import { apiClient, type ApiError } from "../../lib/api-client";

/**
 * Format bytes to human-readable format
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * Format relative time from ISO date string
 */
function formatRelativeTime(isoDate: string): string {
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
 * List response from /api/storages/list
 */
interface StorageListItem {
  name: string;
  size: number;
  fileCount: number;
  updatedAt: string;
}

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List all remote volumes")
  .action(async () => {
    try {
      // Call API
      const url = "/api/storages/list?type=volume";
      const response = await apiClient.get(url);

      if (!response.ok) {
        const error = (await response.json()) as ApiError;
        throw new Error(error.error?.message || "List failed");
      }

      const items = (await response.json()) as StorageListItem[];

      if (items.length === 0) {
        console.log(chalk.dim("No volumes found"));
        console.log(
          chalk.dim("  Create one with: vm0 volume init && vm0 volume push"),
        );
        return;
      }

      // Calculate column widths
      const nameWidth = Math.max(4, ...items.map((i) => i.name.length));
      const sizeWidth = Math.max(
        4,
        ...items.map((i) => formatBytes(i.size).length),
      );
      const filesWidth = Math.max(
        5,
        ...items.map((i) => i.fileCount.toString().length),
      );

      // Print header
      const header = [
        "NAME".padEnd(nameWidth),
        "SIZE".padStart(sizeWidth),
        "FILES".padStart(filesWidth),
        "UPDATED",
      ].join("  ");
      console.log(chalk.dim(header));

      // Print rows
      for (const item of items) {
        const row = [
          item.name.padEnd(nameWidth),
          formatBytes(item.size).padStart(sizeWidth),
          item.fileCount.toString().padStart(filesWidth),
          formatRelativeTime(item.updatedAt),
        ].join("  ");
        console.log(row);
      }
    } catch (error) {
      console.error(chalk.red("✗ Failed to list volumes"));
      if (error instanceof Error) {
        if (error.message.includes("Not authenticated")) {
          console.error(chalk.dim("  Run: vm0 auth login"));
        } else {
          console.error(chalk.dim(`  ${error.message}`));
        }
      }
      process.exit(1);
    }
  });
