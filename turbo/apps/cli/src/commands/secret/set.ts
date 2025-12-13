import { Command } from "commander";
import chalk from "chalk";
import { createSecret, getErrorMessage } from "../../lib/secrets-client";

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
      // Client-side validation for better UX (server also validates)
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

      const result = await createSecret(name, value);

      if (result.status === 201) {
        console.log(chalk.green(`✓ Secret created: ${result.body.name}`));
      } else if (result.status === 200) {
        console.log(chalk.green(`✓ Secret updated: ${result.body.name}`));
      } else {
        // 400 or 401 error
        throw new Error(getErrorMessage(result.body, "Failed to set secret"));
      }
    } catch (error) {
      console.error(chalk.red("✗ Failed to set secret"));
      if (error instanceof Error) {
        console.error(chalk.gray(`  ${error.message}`));
      }
      process.exit(1);
    }
  });
