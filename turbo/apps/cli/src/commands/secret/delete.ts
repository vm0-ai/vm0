import { Command } from "commander";
import chalk from "chalk";
import {
  apiClient,
  DeleteSecretResponse,
  ApiError,
} from "../../lib/api-client";

export const deleteCommand = new Command()
  .name("delete")
  .alias("rm")
  .description("Delete a secret")
  .argument("<name>", "Secret name to delete")
  .action(async (name: string) => {
    try {
      const response = await apiClient.delete(
        `/api/secrets?name=${encodeURIComponent(name)}`,
      );

      if (!response.ok) {
        const error = (await response.json()) as ApiError;
        throw new Error(error.error?.message || `Secret not found: ${name}`);
      }

      const result = (await response.json()) as DeleteSecretResponse;

      if (result.deleted) {
        console.log(chalk.green(`✓ Secret deleted: ${name}`));
      }
    } catch (error) {
      console.error(chalk.red("✗ Failed to delete secret"));
      if (error instanceof Error) {
        console.error(chalk.gray(`  ${error.message}`));
      }
      process.exit(1);
    }
  });
