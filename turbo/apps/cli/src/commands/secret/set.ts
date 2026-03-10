import { Command } from "commander";
import chalk from "chalk";
import { setSecret } from "../../lib/api";
import { isInteractive, promptPassword } from "../../lib/utils/prompt-utils";
import { withErrorHandler } from "../../lib/command";

export const setCommand = new Command()
  .name("set")
  .description("Create or update a secret")
  .argument("<name>", "Secret name (uppercase, e.g., MY_API_KEY)")
  .option(
    "-b, --body <value>",
    "Secret value (required in non-interactive mode)",
  )
  .option("-d, --description <description>", "Optional description")
  .action(
    withErrorHandler(
      async (
        name: string,
        options: { body?: string; description?: string },
      ) => {
        // Resolve the secret value
        let value: string;

        if (options.body !== undefined) {
          value = options.body;
        } else if (isInteractive()) {
          const prompted = await promptPassword("Enter secret value:");
          if (prompted === undefined) {
            // User cancelled (Ctrl+C)
            process.exit(0);
          }
          value = prompted;
        } else {
          console.error(
            chalk.red("✗ --body is required in non-interactive mode"),
          );
          console.error();
          console.error("Usage:");
          console.error(
            chalk.cyan(`  vm0 secret set ${name} --body "your-secret-value"`),
          );
          process.exit(1);
        }

        const secret = await setSecret({
          name,
          value,
          description: options.description,
        });

        console.log(chalk.green(`✓ Secret "${secret.name}" saved`));
        console.log();
        console.log("Use in vm0.yaml:");
        console.log(chalk.cyan(`  environment:`));
        console.log(chalk.cyan(`    ${name}: \${{ secrets.${name} }}`));
      },
    ),
  );
