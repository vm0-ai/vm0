import { Command } from "commander";
import chalk from "chalk";
import { readStorageConfig } from "../../lib/storage-utils";
import { directUpload } from "../../lib/direct-upload";

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

export const pushCommand = new Command()
  .name("push")
  .description("Push local files to cloud volume")
  .option(
    "-f, --force",
    "Force upload even if content unchanged (recreate archive)",
  )
  .action(async (options: { force?: boolean }) => {
    try {
      const cwd = process.cwd();

      // Read storage config
      const config = await readStorageConfig(cwd);
      if (!config) {
        console.error(chalk.red("✗ No volume initialized in this directory"));
        console.error(chalk.dim("  Run: vm0 volume init"));
        process.exit(1);
      }

      console.log(`Pushing volume: ${config.name}`);

      // Perform direct S3 upload
      const result = await directUpload(config.name, "volume", cwd, {
        onProgress: (message) => {
          console.log(chalk.dim(message));
        },
        force: options.force,
      });

      // Display short version (8 characters) by default
      const shortVersion = result.versionId.slice(0, 8);

      if (result.empty) {
        console.log(chalk.yellow("No files found (empty volume)"));
      } else if (result.deduplicated) {
        console.log(chalk.green("✓ Content unchanged (deduplicated)"));
      } else {
        console.log(chalk.green("✓ Upload complete"));
      }
      console.log(chalk.dim(`  Version: ${shortVersion}`));
      console.log(chalk.dim(`  Files: ${result.fileCount.toLocaleString()}`));
      console.log(chalk.dim(`  Size: ${formatBytes(result.size)}`));
    } catch (error) {
      console.error(chalk.red("✗ Push failed"));
      if (error instanceof Error) {
        console.error(chalk.dim(`  ${error.message}`));
      }
      process.exit(1);
    }
  });
