import { Command } from "commander";
import chalk from "chalk";
import { setCredential } from "../../lib/api";

export const setCommand = new Command()
  .name("set")
  .description("Create or update a credential")
  .argument("<name>", "Credential name (uppercase, e.g., MY_API_KEY)")
  .argument("<value>", "Credential value")
  .option("-d, --description <description>", "Optional description")
  .action(
    async (name: string, value: string, options: { description?: string }) => {
      try {
        const credential = await setCredential({
          name,
          value,
          description: options.description,
        });

        console.log(chalk.green(`✓ Credential "${credential.name}" saved`));
        console.log();
        console.log("Use in vm0.yaml:");
        console.log(chalk.cyan(`  environment:`));
        console.log(chalk.cyan(`    ${name}: \${{ credentials.${name} }}`));
      } catch (error) {
        if (error instanceof Error) {
          if (error.message.includes("Not authenticated")) {
            console.error(
              chalk.red("✗ Not authenticated. Run: vm0 auth login"),
            );
          } else if (error.message.includes("must contain only uppercase")) {
            console.error(chalk.red(`✗ ${error.message}`));
            console.log();
            console.log("Examples of valid credential names:");
            console.log(chalk.dim("  MY_API_KEY"));
            console.log(chalk.dim("  GITHUB_TOKEN"));
            console.log(chalk.dim("  AWS_ACCESS_KEY_ID"));
          } else {
            console.error(chalk.red(`✗ ${error.message}`));
          }
        } else {
          console.error(chalk.red("✗ An unexpected error occurred"));
        }
        process.exit(1);
      }
    },
  );
