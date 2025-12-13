import { Command } from "commander";
import chalk from "chalk";
import { listSecrets, getErrorMessage } from "../../lib/secrets-client";

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List all secrets (names only)")
  .action(async () => {
    try {
      const result = await listSecrets();

      if (result.status !== 200) {
        throw new Error(getErrorMessage(result.body, "Failed to list secrets"));
      }

      const { secrets } = result.body;

      if (secrets.length === 0) {
        console.log(chalk.gray("No secrets found"));
        console.log(
          chalk.gray("  Create one with: vm0 secret set <name> <value>"),
        );
        return;
      }

      console.log(chalk.cyan("Secrets:"));
      for (const secret of secrets) {
        const updatedAt = new Date(secret.updatedAt).toLocaleDateString();
        console.log(
          `  ${chalk.white(secret.name)} ${chalk.gray(`(updated: ${updatedAt})`)}`,
        );
      }
      console.log(chalk.gray(`\nTotal: ${secrets.length} secret(s)`));
    } catch (error) {
      console.error(chalk.red("✗ Failed to list secrets"));
      if (error instanceof Error) {
        console.error(chalk.gray(`  ${error.message}`));
      }
      process.exit(1);
    }
  });
