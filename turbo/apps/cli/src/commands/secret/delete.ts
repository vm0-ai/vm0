import { Command } from "commander";
import chalk from "chalk";
import { deleteSecret, getErrorMessage } from "../../lib/secrets-client";

export const deleteCommand = new Command()
  .name("delete")
  .alias("rm")
  .description("Delete a secret")
  .argument("<name>", "Secret name to delete")
  .action(async (name: string) => {
    try {
      const result = await deleteSecret(name);

      if (result.status === 200) {
        console.log(chalk.green(`✓ Secret deleted: ${result.body.name}`));
      } else {
        // 400, 401, or 404 error
        throw new Error(
          getErrorMessage(result.body, `Secret not found: ${name}`),
        );
      }
    } catch (error) {
      console.error(chalk.red("✗ Failed to delete secret"));
      if (error instanceof Error) {
        console.error(chalk.gray(`  ${error.message}`));
      }
      process.exit(1);
    }
  });
