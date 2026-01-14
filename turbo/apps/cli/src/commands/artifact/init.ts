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
  .description("Initialize an artifact in the current directory")
  .option(
    "-n, --name <name>",
    "Artifact name (required in non-interactive mode)",
  )
  .action(async (options: { name?: string }) => {
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

      // Determine artifact name
      let artifactName: string;

      if (options.name) {
        // Use provided name (non-interactive mode)
        artifactName = options.name;
      } else if (!isInteractive()) {
        // Non-interactive mode without --name flag
        console.error(
          chalk.red("✗ --name flag is required in non-interactive mode"),
        );
        console.error(
          chalk.dim("  Usage: vm0 artifact init --name <artifact-name>"),
        );
        process.exit(1);
      } else {
        // Interactive prompt with directory name as default
        const defaultName = isValidStorageName(dirName) ? dirName : undefined;
        const name = await promptText(
          "Enter artifact name",
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

        artifactName = name;
      }

      // Validate name
      if (!isValidStorageName(artifactName)) {
        console.error(chalk.red(`✗ Invalid artifact name: "${artifactName}"`));
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
