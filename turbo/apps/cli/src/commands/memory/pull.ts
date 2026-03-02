import { Command } from "commander";
import chalk from "chalk";
import { cloneStorage } from "../../lib/storage/clone-utils";
import { withErrorHandler } from "../../lib/command";

export const pullCommand = new Command()
  .name("pull")
  .description("Pull remote memory to local directory (latest version)")
  .argument("[name]", "Memory name to pull", "memory")
  .argument("[destination]", "Destination directory (default: memory name)")
  .action(
    withErrorHandler(async (name: string, destination: string | undefined) => {
      const targetDir = destination || name;

      console.log(`Pulling memory: ${name}`);

      const result = await cloneStorage(name, "memory", targetDir);

      console.log(chalk.green(`\n✓ Successfully pulled memory: ${name}`));
      console.log(chalk.dim(`  Location: ${targetDir}/`));
      console.log(chalk.dim(`  Version: ${result.versionId.slice(0, 8)}`));
    }),
  );
