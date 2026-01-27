import { Command } from "commander";
import chalk from "chalk";
import { readStorageConfig } from "../../lib/storage/storage-utils";
import { getStorageDownload } from "../../lib/api";
import { formatBytes } from "../../lib/utils/file-utils";

export const statusCommand = new Command()
  .name("status")
  .description("Show status of cloud artifact")
  .action(async () => {
    try {
      const cwd = process.cwd();

      // Read config
      const config = await readStorageConfig(cwd);
      if (!config) {
        console.error(chalk.red("✗ No artifact initialized in this directory"));
        console.error(chalk.dim("  Run: vm0 artifact init"));
        process.exit(1);
      }

      if (config.type !== "artifact") {
        console.error(
          chalk.red(
            "✗ This directory is initialized as a volume, not an artifact",
          ),
        );
        console.error(chalk.dim("  Use: vm0 volume status"));
        process.exit(1);
      }

      // Start message
      console.log(`Checking artifact: ${config.name}`);

      // Call API
      const info = await getStorageDownload({
        name: config.name,
        type: "artifact",
      });
      const shortVersion = info.versionId.slice(0, 8);

      if ("empty" in info) {
        console.log(chalk.green("✓ Found (empty)"));
        console.log(chalk.dim(`  Version: ${shortVersion}`));
      } else {
        console.log(chalk.green("✓ Found"));
        console.log(chalk.dim(`  Version: ${shortVersion}`));
        console.log(chalk.dim(`  Files: ${info.fileCount.toLocaleString()}`));
        console.log(chalk.dim(`  Size: ${formatBytes(info.size)}`));
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) {
        console.error(chalk.red("✗ Not found on remote"));
        console.error(chalk.dim("  Run: vm0 artifact push"));
      } else {
        console.error(chalk.red("✗ Status check failed"));
        if (error instanceof Error) {
          console.error(chalk.dim(`  ${error.message}`));
        }
      }
      process.exit(1);
    }
  });
