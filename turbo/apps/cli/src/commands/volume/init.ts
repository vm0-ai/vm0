import { Command } from "commander";
import chalk from "chalk";
import path from "path";
import {
  isValidStorageName,
  writeStorageConfig,
  readStorageConfig,
} from "../../lib/storage/storage-utils";
import { promptText, isInteractive } from "../../lib/utils/prompt-utils";

export const initCommand = new Command()
  .name("init")
  .description("Initialize a volume in the current directory")
  .option("-n, --name <name>", "Volume name (required in non-interactive mode)")
  .action(async (options: { name?: string }) => {
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

      // Determine volume name
      let volumeName: string;

      if (options.name) {
        // Use provided name (non-interactive mode)
        volumeName = options.name;
      } else if (!isInteractive()) {
        // Non-interactive mode without --name flag
        console.error(
          chalk.red("✗ --name flag is required in non-interactive mode"),
        );
        console.error(
          chalk.dim("  Usage: vm0 volume init --name <volume-name>"),
        );
        process.exit(1);
      } else {
        // Interactive prompt with directory name as default
        const defaultName = isValidStorageName(dirName) ? dirName : undefined;
        const name = await promptText(
          "Enter volume name",
          defaultName,
          (value: string) => {
            if (!isValidStorageName(value)) {
              return "Must be 3-64 characters, lowercase alphanumeric with hyphens";
            }
            return true;
          },
        );

        if (name === undefined) {
          // User cancelled
          console.log(chalk.dim("Cancelled"));
          return;
        }

        volumeName = name;
      }

      // Validate volume name
      if (!isValidStorageName(volumeName)) {
        console.error(chalk.red(`✗ Invalid volume name: "${volumeName}"`));
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
