import { Command } from "commander";
import chalk from "chalk";
import { cloneStorage } from "../../lib/storage/clone-utils";
import { withErrorHandler } from "../../lib/command";

export const cloneCommand = new Command()
  .name("clone")
  .description("Clone a remote memory to local directory (latest version)")
  .argument("<name>", "Memory name to clone")
  .argument("[destination]", "Destination directory (default: memory name)")
  .action(
    withErrorHandler(async (name: string, destination: string | undefined) => {
      // Use memory name as destination if not specified
      const targetDir = destination || name;

      console.log(`Cloning memory: ${name}`);

      const result = await cloneStorage(name, "memory", targetDir);

      console.log(chalk.green(`\n✓ Successfully cloned memory: ${name}`));
      console.log(chalk.dim(`  Location: ${targetDir}/`));
      console.log(chalk.dim(`  Version: ${result.versionId.slice(0, 8)}`));
    }),
  );
