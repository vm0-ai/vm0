import { Command } from "commander";
import chalk from "chalk";
import { readStorageConfig } from "../../lib/storage/storage-utils";
import { directUpload } from "../../lib/storage/direct-upload";
import { formatBytes } from "../../lib/utils/file-utils";
import { withErrorHandler } from "../../lib/command";

export const pushCommand = new Command()
  .name("push")
  .description("Push local files to cloud memory")
  .option(
    "-f, --force",
    "Force upload even if content unchanged (recreate archive)",
  )
  .action(
    withErrorHandler(async (options: { force?: boolean }) => {
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
          { cause: new Error(`Use: vm0 ${config.type} push`) },
        );
      }

      console.log(`Pushing memory: ${config.name}`);

      // Perform direct S3 upload
      const result = await directUpload(config.name, "memory", cwd, {
        onProgress: (message) => {
          console.log(chalk.dim(message));
        },
        force: options.force,
      });

      // Display short version (8 characters) by default
      const shortVersion = result.versionId.slice(0, 8);

      if (result.empty) {
        console.log(chalk.dim("No files found (empty memory)"));
      } else if (result.deduplicated) {
        console.log(chalk.green("✓ Content unchanged (deduplicated)"));
      } else {
        console.log(chalk.green("✓ Upload complete"));
      }
      console.log(chalk.dim(`  Version: ${shortVersion}`));
      console.log(chalk.dim(`  Files: ${result.fileCount.toLocaleString()}`));
      console.log(chalk.dim(`  Size: ${formatBytes(result.size)}`));
    }),
  );
