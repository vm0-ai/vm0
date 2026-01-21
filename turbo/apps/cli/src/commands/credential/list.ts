import { Command } from "commander";
import chalk from "chalk";
import { listCredentials } from "../../lib/api";

export const listCommand = new Command()
  .name("list")
  .description("List all credentials")
  .option("--json", "Output in JSON format")
  .action(async (options: { json?: boolean }) => {
    try {
      const result = await listCredentials();

      if (options.json) {
        console.log(JSON.stringify(result.credentials, null, 2));
        return;
      }

      if (result.credentials.length === 0) {
        console.log(chalk.dim("No credentials found."));
        console.log();
        console.log("To add a credential:");
        console.log(
          chalk.cyan("  vm0 experimental-credential set MY_API_KEY <value>"),
        );
        return;
      }

      console.log(chalk.bold("Credentials:"));
      console.log();

      for (const credential of result.credentials) {
        console.log(`  ${chalk.cyan(credential.name)}`);
        if (credential.description) {
          console.log(`    ${chalk.dim(credential.description)}`);
        }
        console.log(
          `    ${chalk.dim(`Updated: ${new Date(credential.updatedAt).toLocaleString()}`)}`,
        );
        console.log();
      }

      console.log(
        chalk.dim(`Total: ${result.credentials.length} credential(s)`),
      );
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes("Not authenticated")) {
          console.error(chalk.red("✗ Not authenticated. Run: vm0 auth login"));
        } else {
          console.error(chalk.red(`✗ ${error.message}`));
        }
      } else {
        console.error(chalk.red("✗ An unexpected error occurred"));
      }
      process.exit(1);
    }
  });
