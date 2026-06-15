import { Command } from "commander";
import chalk from "chalk";
import { cloneStorage } from "../../lib/storage/clone-utils";
import { withErrorHandler } from "../../lib/command";

export const cloneCommand = new Command()
  .name("clone")
  .description("Clone a remote volume to local directory (latest version)")
  .argument("<name>", "Volume name to clone")
  .argument("[destination]", "Destination directory (default: volume name)")
  .action(
    withErrorHandler(async (name: string, destination: string | undefined) => {
      // Use volume name as destination if not specified
      const targetDir = destination || name;

      console.log(`Cloning volume: ${name}`);

      const result = await cloneStorage(name, "volume", targetDir);

      console.log(chalk.green(`\n✓ Successfully cloned volume: ${name}`));
      console.log(chalk.dim(`  Location: ${targetDir}/`));
      console.log(chalk.dim(`  Version: ${result.versionId.slice(0, 8)}`));
    }),
  );
