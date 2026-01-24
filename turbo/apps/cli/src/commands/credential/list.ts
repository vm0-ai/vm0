import { Command } from "commander";
import chalk from "chalk";
import { listCredentials } from "../../lib/api";

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List all credentials")
  .action(async () => {
    try {
      const result = await listCredentials();

      if (result.credentials.length === 0) {
        console.log(chalk.dim("No credentials found."));
        console.log();
        console.log("To add a credential:");
        console.log(chalk.cyan("  vm0 credential set MY_API_KEY <value>"));
        return;
      }

      console.log(chalk.bold("Credentials:"));
      console.log();

      for (const credential of result.credentials) {
        const typeIndicator =
          credential.type === "model-provider"
            ? chalk.dim(" [model-provider]")
            : "";
        console.log(`  ${chalk.cyan(credential.name)}${typeIndicator}`);
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
