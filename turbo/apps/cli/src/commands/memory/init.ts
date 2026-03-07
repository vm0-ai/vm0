import { Command } from "commander";
import chalk from "chalk";
import path from "path";
import {
  isValidStorageName,
  writeStorageConfig,
  readStorageConfig,
} from "../../lib/storage/storage-utils";
import { promptText, isInteractive } from "../../lib/utils/prompt-utils";
import { withErrorHandler } from "../../lib/command";

export const initCommand = new Command()
  .name("init")
  .description("Initialize a memory in the current directory")
  .option("-n, --name <name>", "Memory name (required in non-interactive mode)")
  .action(
    withErrorHandler(async (options: { name?: string }) => {
      const cwd = process.cwd();
      const dirName = path.basename(cwd);

      // Check if config already exists
      const existingConfig = await readStorageConfig(cwd);
      if (existingConfig) {
        if (existingConfig.type === "memory") {
          console.log(
            chalk.yellow(`Memory already initialized: ${existingConfig.name}`),
          );
        } else {
          console.log(
            chalk.yellow(
              `Directory already initialized as ${existingConfig.type}: ${existingConfig.name}`,
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

      // Determine memory name
      let memoryName: string;

      if (options.name) {
        memoryName = options.name;
      } else if (!isInteractive()) {
        console.error(
          chalk.red("✗ --name flag is required in non-interactive mode"),
        );
        console.error(
          chalk.dim("  Usage: vm0 memory init --name <memory-name>"),
        );
        process.exit(1);
      } else {
        // Interactive prompt with directory name as default
        const defaultName = isValidStorageName(dirName) ? dirName : undefined;
        const name = await promptText(
          "Enter memory name",
          defaultName,
          (value: string) => {
            if (!isValidStorageName(value)) {
              return "Must be 3-64 characters, lowercase alphanumeric with hyphens";
            }
            return true;
          },
        );

        if (name === undefined) {
          console.log(chalk.dim("Cancelled"));
          return;
        }

        memoryName = name;
      }

      // Validate name
      if (!isValidStorageName(memoryName)) {
        console.error(chalk.red(`✗ Invalid memory name: "${memoryName}"`));
        console.error(
          chalk.dim(
            "  Memory names must be 3-64 characters, lowercase alphanumeric with hyphens",
          ),
        );
        console.error(
          chalk.dim("  Example: my-memory, agent-context, project-memory"),
        );
        process.exit(1);
      }

      // Write config file with type: memory
      await writeStorageConfig(memoryName, cwd, "memory");

      console.log(chalk.green(`✓ Initialized memory: ${memoryName}`));
      console.log(
        chalk.dim(
          `  Config saved to ${path.join(cwd, ".vm0", "storage.yaml")}`,
        ),
      );
    }),
  );
