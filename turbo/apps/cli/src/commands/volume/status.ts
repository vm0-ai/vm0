import { Command } from "commander";
import chalk from "chalk";
import { readStorageConfig } from "../../lib/storage-utils";
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
 * Status response from /api/storages/download
 */
interface StatusResponse {
  url?: string;
  empty?: boolean;
  versionId: string;
  fileCount: number;
  size: number;
}

export const statusCommand = new Command()
  .name("status")
  .description("Show status of cloud volume")
  .action(async () => {
    try {
      const cwd = process.cwd();

      // Read config
      const config = await readStorageConfig(cwd);
      if (!config) {
        console.error(chalk.red("✗ No volume initialized in this directory"));
        console.error(chalk.gray("  Run: vm0 volume init"));
        process.exit(1);
      }

      if (config.type !== "volume") {
        console.error(
          chalk.red(
            "✗ This directory is initialized as an artifact, not a volume",
          ),
        );
        console.error(chalk.gray("  Use: vm0 artifact status"));
        process.exit(1);
      }

      // Start message
      console.log(chalk.cyan(`Checking volume: ${config.name}`));

      // Call API
      const url = `/api/storages/download?name=${encodeURIComponent(config.name)}&type=volume`;
      const response = await apiClient.get(url);

      if (!response.ok) {
        if (response.status === 404) {
          console.error(chalk.red("✗ Not found on remote"));
          console.error(chalk.gray("  Run: vm0 volume push"));
        } else {
          const error = (await response.json()) as ApiError;
          throw new Error(error.error?.message || "Status check failed");
        }
        process.exit(1);
      }

      const info = (await response.json()) as StatusResponse;
      const shortVersion = info.versionId.slice(0, 8);

      if (info.empty) {
        console.log(chalk.green("✓ Found (empty)"));
        console.log(chalk.gray(`  Version: ${shortVersion}`));
      } else {
        console.log(chalk.green("✓ Found"));
        console.log(chalk.gray(`  Version: ${shortVersion}`));
        console.log(chalk.gray(`  Files: ${info.fileCount.toLocaleString()}`));
        console.log(chalk.gray(`  Size: ${formatBytes(info.size)}`));
      }
    } catch (error) {
      console.error(chalk.red("✗ Status check failed"));
      if (error instanceof Error) {
        console.error(chalk.gray(`  ${error.message}`));
      }
      process.exit(1);
    }
  });
