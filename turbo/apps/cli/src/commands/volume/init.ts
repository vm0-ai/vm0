import { Command } from "commander";
import chalk from "chalk";
import path from "path";
import {
  isValidVolumeName,
  writeVolumeConfig,
  readVolumeConfig,
} from "../../lib/volume-utils";

export const initCommand = new Command()
  .name("init")
  .description("Initialize a volume in the current directory")
  .action(async () => {
    try {
      const cwd = process.cwd();
      const dirName = path.basename(cwd);

      // Check if volume config already exists
      const existingConfig = await readVolumeConfig(cwd);
      if (existingConfig) {
        console.log(
          chalk.yellow(`Volume already initialized: ${existingConfig.name}`),
        );
        console.log(
          chalk.gray(`Config file: ${path.join(cwd, ".vm0", "volume.yaml")}`),
        );
        return;
      }

      // Use directory name as volume name
      const volumeName = dirName;

      // Validate volume name
      if (!isValidVolumeName(volumeName)) {
        console.error(chalk.red(`✗ Invalid volume name: "${dirName}"`));
        console.error(
          chalk.gray(
            "  Volume names must be 3-64 characters, lowercase alphanumeric with hyphens",
          ),
        );
        console.error(
          chalk.gray("  Example: my-dataset, user-data-v2, training-set-2024"),
        );
        process.exit(1);
      }

      // Write config file
      await writeVolumeConfig(volumeName, cwd);

      console.log(chalk.green(`✓ Initialized volume: ${volumeName}`));
      console.log(
        chalk.gray(
          `✓ Config saved to ${path.join(cwd, ".vm0", "volume.yaml")}`,
        ),
      );
    } catch (error) {
      console.error(chalk.red("✗ Failed to initialize volume"));
      if (error instanceof Error) {
        console.error(chalk.gray(`  ${error.message}`));
      }
      process.exit(1);
    }
  });
