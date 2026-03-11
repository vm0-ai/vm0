import { Command } from "commander";
import chalk from "chalk";
import { readStorageConfig } from "../../lib/storage/storage-utils";
import { getStorageDownload, ApiRequestError } from "../../lib/api";
import { formatBytes } from "../../lib/utils/file-utils";
import { withErrorHandler } from "../../lib/command";

export const statusCommand = new Command()
  .name("status")
  .description("Show status of cloud artifact")
  .action(
    withErrorHandler(async () => {
      const cwd = process.cwd();

      // Read config
      const config = await readStorageConfig(cwd);
      if (!config) {
        throw new Error("No artifact initialized in this directory", {
          cause: new Error("Run: vm0 artifact init"),
        });
      }

      if (config.type !== "artifact") {
        throw new Error(
          "This directory is initialized as a volume, not an artifact",
          { cause: new Error("Use: vm0 volume status") },
        );
      }

      // Start message
      console.log(`Checking artifact: ${config.name}`);

      // Call API
      try {
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
        if (error instanceof ApiRequestError && error.status === 404) {
          throw new Error("Not found on remote", {
            cause: new Error("Run: vm0 artifact push"),
          });
        }
        throw error;
      }
    }),
  );
