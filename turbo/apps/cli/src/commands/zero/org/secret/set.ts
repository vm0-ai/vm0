import { Command } from "commander";
import chalk from "chalk";
import { setZeroOrgSecret } from "../../../../lib/api";
import {
  isInteractive,
  promptPassword,
} from "../../../../lib/utils/prompt-utils";
import { withErrorHandler } from "../../../../lib/command";

export const setCommand = new Command()
  .name("set")
  .description("Create or update an org-level secret (admin only)")
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
        let value: string;

        if (options.body !== undefined) {
          value = options.body;
        } else if (isInteractive()) {
          const prompted = await promptPassword("Enter secret value:");
          if (prompted === undefined) {
            console.log(chalk.dim("Cancelled"));
            return;
          }
          value = prompted;
        } else {
          throw new Error("--body is required in non-interactive mode", {
            cause: new Error(
              `Usage: zero org secret set ${name} --body "your-secret-value"`,
            ),
          });
        }

        let secret;
        try {
          secret = await setZeroOrgSecret({
            name,
            value,
            description: options.description,
          });
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.includes("must contain only uppercase")
          ) {
            throw new Error(error.message, {
              cause: new Error(
                "Examples of valid secret names: MY_API_KEY, GITHUB_TOKEN, AWS_ACCESS_KEY_ID",
              ),
            });
          }
          throw error;
        }

        console.log(chalk.green(`✓ Org secret "${secret.name}" saved`));
      },
    ),
  );
