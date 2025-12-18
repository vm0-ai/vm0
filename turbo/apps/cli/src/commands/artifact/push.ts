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
  .description("Push local files to cloud artifact")
  .option(
    "-f, --force",
    "Force upload even if content unchanged (recreate archive)",
  )
  .action(async (options: { force?: boolean }) => {
    try {
      const cwd = process.cwd();

      // Read config
      const config = await readStorageConfig(cwd);
      if (!config) {
        console.error(chalk.red("✗ No artifact initialized in this directory"));
        console.error(chalk.gray("  Run: vm0 artifact init"));
        process.exit(1);
      }

      if (config.type !== "artifact") {
        console.error(
          chalk.red(
            `✗ This directory is initialized as a volume, not an artifact`,
          ),
        );
        console.error(chalk.gray("  Use: vm0 volume push"));
        process.exit(1);
      }

      console.log(chalk.cyan(`Pushing artifact: ${config.name}`));

      // Perform direct S3 upload
      const result = await directUpload(config.name, "artifact", cwd, {
        onProgress: (message) => {
          console.log(chalk.gray(message));
        },
        force: options.force,
      });

      // Display short version (8 characters) by default
      const shortVersion = result.versionId.slice(0, 8);

      if (result.empty) {
        console.log(chalk.yellow("No files found (empty artifact)"));
      } else if (result.deduplicated) {
        console.log(chalk.green("✓ Content unchanged (deduplicated)"));
      } else {
        console.log(chalk.green("✓ Upload complete"));
      }
      console.log(chalk.gray(`  Version: ${shortVersion}`));
      console.log(chalk.gray(`  Files: ${result.fileCount.toLocaleString()}`));
      console.log(chalk.gray(`  Size: ${formatBytes(result.size)}`));
    } catch (error) {
      console.error(chalk.red("✗ Push failed"));
      if (error instanceof Error) {
        console.error(chalk.gray(`  ${error.message}`));
      }
      process.exit(1);
    }
  });
