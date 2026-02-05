import { Command } from "commander";
import chalk from "chalk";
import { listSecrets } from "../../lib/api";

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List all secrets")
  .action(async () => {
    try {
      const result = await listSecrets();

      if (result.secrets.length === 0) {
        console.log(chalk.dim("No secrets found"));
        console.log();
        console.log("To add a secret:");
        console.log(chalk.cyan("  vm0 secret set MY_API_KEY --body <value>"));
        return;
      }

      console.log(chalk.bold("Secrets:"));
      console.log();

      for (const secret of result.secrets) {
        const typeIndicator =
          secret.type === "model-provider"
            ? chalk.dim(" [model-provider]")
            : "";
        console.log(`  ${chalk.cyan(secret.name)}${typeIndicator}`);
        if (secret.description) {
          console.log(`    ${chalk.dim(secret.description)}`);
        }
        console.log(
          `    ${chalk.dim(`Updated: ${new Date(secret.updatedAt).toLocaleString()}`)}`,
        );
        console.log();
      }

      console.log(chalk.dim(`Total: ${result.secrets.length} secret(s)`));
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
