import { Command } from "commander";
import chalk from "chalk";
import { readStorageConfig } from "../../lib/storage/storage-utils";
import { directUpload } from "../../lib/storage/direct-upload";
import { formatBytes } from "../../lib/utils/file-utils";
import { withErrorHandler } from "../../lib/command";

export const pushCommand = new Command()
  .name("push")
  .description("Push local files to cloud artifact")
  .option(
    "-f, --force",
    "Force upload even if content unchanged (recreate archive)",
  )
  .action(
    withErrorHandler(async (options: { force?: boolean }) => {
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
          { cause: new Error("Use: vm0 volume push") },
        );
      }

      console.log(`Pushing artifact: ${config.name}`);

      // Perform direct S3 upload
      const result = await directUpload(config.name, "artifact", cwd, {
        onProgress: (message) => {
          console.log(chalk.dim(message));
        },
        force: options.force,
      });

      // Display short version (8 characters) by default
      const shortVersion = result.versionId.slice(0, 8);

      if (result.empty) {
        console.log(chalk.dim("No files found (empty artifact)"));
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
