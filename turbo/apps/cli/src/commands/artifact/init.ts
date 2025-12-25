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
  .description("Initialize an artifact in the current directory")
  .action(async () => {
    try {
      const cwd = process.cwd();
      const dirName = path.basename(cwd);

      // Check if config already exists
      const existingConfig = await readStorageConfig(cwd);
      if (existingConfig) {
        if (existingConfig.type === "artifact") {
          console.log(
            chalk.yellow(
              `Artifact already initialized: ${existingConfig.name}`,
            ),
          );
        } else {
          console.log(
            chalk.yellow(
              `Directory already initialized as volume: ${existingConfig.name}`,
            ),
          );
          console.log(
            chalk.dim(
              "  To change type, delete .vm0/storage.yaml and reinitialize",
            ),
          );
        }
        console.log(
          chalk.dim(`Config file: ${path.join(cwd, ".vm0", "storage.yaml")}`),
        );
        return;
      }

      // Use directory name as artifact name
      const artifactName = dirName;

      // Validate name
      if (!isValidStorageName(artifactName)) {
        console.error(chalk.red(`✗ Invalid artifact name: "${dirName}"`));
        console.error(
          chalk.dim(
            "  Artifact names must be 3-64 characters, lowercase alphanumeric with hyphens",
          ),
        );
        console.error(
          chalk.dim("  Example: my-project, user-workspace, code-artifact"),
        );
        process.exit(1);
      }

      // Write config file with type: artifact
      await writeStorageConfig(artifactName, cwd, "artifact");

      console.log(chalk.green(`✓ Initialized artifact: ${artifactName}`));
      console.log(
        chalk.dim(
          `✓ Config saved to ${path.join(cwd, ".vm0", "storage.yaml")}`,
        ),
      );
    } catch (error) {
      console.error(chalk.red("✗ Failed to initialize artifact"));
      if (error instanceof Error) {
        console.error(chalk.dim(`  ${error.message}`));
      }
      process.exit(1);
    }
  });
