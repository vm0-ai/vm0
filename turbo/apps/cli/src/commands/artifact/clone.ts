import { Command } from "commander";
import chalk from "chalk";
import { cloneStorage } from "../../lib/storage/clone-utils";
import { withErrorHandler } from "../../lib/command";

export const cloneCommand = new Command()
  .name("clone")
  .description("Clone a remote artifact to local directory (latest version)")
  .argument("<name>", "Artifact name to clone")
  .argument("[destination]", "Destination directory (default: artifact name)")
  .action(
    withErrorHandler(async (name: string, destination: string | undefined) => {
      // Use artifact name as destination if not specified
      const targetDir = destination || name;

      console.log(`Cloning artifact: ${name}`);

      const result = await cloneStorage(name, "artifact", targetDir);

      console.log(chalk.green(`\n✓ Successfully cloned artifact: ${name}`));
      console.log(chalk.dim(`  Location: ${targetDir}/`));
      console.log(chalk.dim(`  Version: ${result.versionId.slice(0, 8)}`));
    }),
  );
