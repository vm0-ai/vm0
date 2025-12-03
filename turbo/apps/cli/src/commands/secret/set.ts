import { Command } from "commander";
import chalk from "chalk";
import { apiClient, SetSecretResponse, ApiError } from "../../lib/api-client";

export const setCommand = new Command()
  .name("set")
  .description("Create or update a secret")
  .argument(
    "<name>",
    "Secret name (must start with letter, alphanumeric and underscores only)",
  )
  .argument("<value>", "Secret value")
  .action(async (name: string, value: string) => {
    try {
      // Validate name format
      const nameRegex = /^[a-zA-Z][a-zA-Z0-9_]*$/;
      if (!nameRegex.test(name)) {
        console.error(chalk.red("✗ Invalid secret name"));
        console.error(
          chalk.gray(
            "  Must start with a letter and contain only letters, numbers, and underscores",
          ),
        );
        process.exit(1);
      }

      if (name.length > 255) {
        console.error(chalk.red("✗ Secret name too long (max 255 characters)"));
        process.exit(1);
      }

      const response = await apiClient.post("/api/secrets", {
        body: JSON.stringify({ name, value }),
      });

      if (!response.ok) {
        const error = (await response.json()) as ApiError;
        throw new Error(error.error?.message || "Failed to set secret");
      }

      const result = (await response.json()) as SetSecretResponse;

      if (result.action === "created") {
        console.log(chalk.green(`✓ Secret created: ${name}`));
      } else {
        console.log(chalk.green(`✓ Secret updated: ${name}`));
      }
    } catch (error) {
      console.error(chalk.red("✗ Failed to set secret"));
      if (error instanceof Error) {
        console.error(chalk.gray(`  ${error.message}`));
      }
      process.exit(1);
    }
  });
