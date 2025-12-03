import { Command } from "commander";
import chalk from "chalk";
import { apiClient, ListSecretsResponse, ApiError } from "../../lib/api-client";

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List all secrets (names only)")
  .action(async () => {
    try {
      const response = await apiClient.get("/api/secrets");

      if (!response.ok) {
        const error = (await response.json()) as ApiError;
        throw new Error(error.error?.message || "Failed to list secrets");
      }

      const result = (await response.json()) as ListSecretsResponse;

      if (result.secrets.length === 0) {
        console.log(chalk.gray("No secrets found"));
        console.log(
          chalk.gray("  Create one with: vm0 secret set <name> <value>"),
        );
        return;
      }

      console.log(chalk.cyan("Secrets:"));
      for (const secret of result.secrets) {
        const updatedAt = new Date(secret.updatedAt).toLocaleDateString();
        console.log(
          `  ${chalk.white(secret.name)} ${chalk.gray(`(updated: ${updatedAt})`)}`,
        );
      }
      console.log(chalk.gray(`\nTotal: ${result.secrets.length} secret(s)`));
    } catch (error) {
      console.error(chalk.red("✗ Failed to list secrets"));
      if (error instanceof Error) {
        console.error(chalk.gray(`  ${error.message}`));
      }
      process.exit(1);
    }
  });
