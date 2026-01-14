import { Command } from "commander";
import chalk from "chalk";
import { cloneStorage } from "../../lib/storage/clone-utils";

export const cloneCommand = new Command()
  .name("clone")
  .description("Clone a remote volume to local directory (latest version)")
  .argument("<name>", "Volume name to clone")
  .argument("[destination]", "Destination directory (default: volume name)")
  .action(async (name: string, destination: string | undefined) => {
    try {
      // Use volume name as destination if not specified
      const targetDir = destination || name;

      console.log(`Cloning volume: ${name}`);

      const result = await cloneStorage(name, "volume", targetDir);

      console.log(chalk.green(`\n✓ Successfully cloned volume: ${name}`));
      console.log(chalk.dim(`  Location: ${targetDir}/`));
      console.log(chalk.dim(`  Version: ${result.versionId.slice(0, 8)}`));
    } catch (error) {
      console.error(chalk.red("✗ Clone failed"));
      if (error instanceof Error) {
        if (error.message.includes("Not authenticated")) {
          console.error(chalk.dim("  Run: vm0 auth login"));
        } else {
          console.error(chalk.dim(`  ${error.message}`));
        }
      }
      process.exit(1);
    }
  });
