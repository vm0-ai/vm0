import { Command } from "commander";
import chalk from "chalk";
import { readStorageConfig } from "../../lib/storage/storage-utils";
import { getStorageDownload, ApiRequestError } from "../../lib/api";
import { formatBytes } from "../../lib/utils/file-utils";
import { withErrorHandler } from "../../lib/command";

export const statusCommand = new Command()
  .name("status")
  .description("Show status of cloud memory")
  .action(
    withErrorHandler(async () => {
      const cwd = process.cwd();

      // Read config. Opt out of memory→artifact normalisation so this
      // command keeps accepting the dirs `vm0 memory init` writes (removed
      // in #10603 together with the rest of the memory CLI).
      const config = await readStorageConfig(cwd, {
        normalizeMemoryToArtifact: false,
      });
      if (!config) {
        throw new Error("No memory initialized in this directory", {
          cause: new Error("Run: vm0 memory init"),
        });
      }

      if (config.type !== "memory") {
        throw new Error(
          `This directory is initialized as ${config.type === "artifact" ? "an artifact" : "a volume"}, not a memory`,
          { cause: new Error(`Use: vm0 ${config.type} status`) },
        );
      }

      // Start message
      console.log(`Checking memory: ${config.name}`);

      // Call API
      try {
        const info = await getStorageDownload({
          name: config.name,
          type: "memory",
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
            cause: new Error("Run: vm0 memory push"),
          });
        }
        throw error;
      }
    }),
  );
