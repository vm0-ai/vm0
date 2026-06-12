import { Command } from "commander";
import chalk from "chalk";
import { updateAutomation } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

interface UpdateOptions {
  name?: string;
  prompt?: string;
  description?: string;
}

export const updateCommand = new Command()
  .name("update")
  .description("Update an automation's name, instruction, or description")
  .argument("<automation>", "Automation ID or name")
  .option("-n, --name <name>", "New automation name")
  .option("-p, --prompt <instruction>", "New instruction")
  .option("--description <text>", "New description")
  .addHelpText(
    "after",
    `
Examples:
  zero automation update alerts -p "Summarize alerts and post to Slack"
  zero automation update alerts -n alerts-v2 --description "Daily alert digest"`,
  )
  .action(
    withErrorHandler(async (ref: string, options: UpdateOptions) => {
      if (
        !options.name &&
        !options.prompt &&
        options.description === undefined
      ) {
        throw new Error(
          "Nothing to update: provide --name, --prompt, or --description",
        );
      }

      const automation = await updateAutomation(ref, {
        name: options.name,
        instruction: options.prompt,
        description: options.description,
      });

      console.log(chalk.green(`✓ Automation "${automation.name}" updated`));
    }),
  );
