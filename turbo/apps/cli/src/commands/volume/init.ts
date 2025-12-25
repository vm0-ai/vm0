import { Command } from "commander";
import chalk from "chalk";
import path from "path";
import {
  isValidStorageName,
  writeStorageConfig,
  readStorageConfig,
} from "../../lib/storage-utils";

export const initCommand = new Command()
  .name("init")
  .description("Initialize a volume in the current directory")
  .action(async () => {
    try {
      const cwd = process.cwd();
      const dirName = path.basename(cwd);

      // Check if storage config already exists
      const existingConfig = await readStorageConfig(cwd);
      if (existingConfig) {
        console.log(
          chalk.yellow(`Volume already initialized: ${existingConfig.name}`),
        );
        console.log(
          chalk.dim(`Config file: ${path.join(cwd, ".vm0", "storage.yaml")}`),
        );
        return;
      }

      // Use directory name as volume name
      const volumeName = dirName;

      // Validate volume name
      if (!isValidStorageName(volumeName)) {
        console.error(chalk.red(`✗ Invalid volume name: "${dirName}"`));
        console.error(
          chalk.dim(
            "  Volume names must be 3-64 characters, lowercase alphanumeric with hyphens",
          ),
        );
        console.error(
          chalk.dim("  Example: my-dataset, user-data-v2, training-set-2024"),
        );
        process.exit(1);
      }

      // Write config file
      await writeStorageConfig(volumeName, cwd);

      console.log(chalk.green(`✓ Initialized volume: ${volumeName}`));
      console.log(
        chalk.dim(
          `✓ Config saved to ${path.join(cwd, ".vm0", "storage.yaml")}`,
        ),
      );
    } catch (error) {
      console.error(chalk.red("✗ Failed to initialize volume"));
      if (error instanceof Error) {
        console.error(chalk.dim(`  ${error.message}`));
      }
      process.exit(1);
    }
  });
