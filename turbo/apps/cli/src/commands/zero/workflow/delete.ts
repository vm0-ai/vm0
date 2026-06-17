import { Command } from "commander";
import chalk from "chalk";
import { deleteWorkflow, getWorkflow } from "../../../lib/api";
import { isInteractive, promptConfirm } from "../../../lib/utils/prompt-utils";
import { withErrorHandler } from "../../../lib/command";

export const deleteCommand = new Command()
  .name("delete")
  .alias("rm")
  .description("Delete a workflow from the organization")
  .argument("<name>", "Workflow name")
  .option("-y, --yes", "Skip confirmation prompt")
  .addHelpText(
    "after",
    `
Examples:
  zero workflow delete my-workflow
  zero workflow delete my-workflow -y

Notes:
  - This removes the workflow from the organization and detaches it from all agents
  - Use -y to skip confirmation in non-interactive mode`,
  )
  .action(
    withErrorHandler(async (name: string, options: { yes?: boolean }) => {
      await getWorkflow(name);

      if (!options.yes) {
        if (!isInteractive()) {
          throw new Error("--yes flag is required in non-interactive mode");
        }
        const confirmed = await promptConfirm(
          `Delete workflow '${name}'? This will detach it from all agents.`,
          false,
        );
        if (!confirmed) {
          console.log(chalk.dim("Cancelled"));
          return;
        }
      }

      await deleteWorkflow(name);
      console.log(chalk.green(`✓ Workflow "${name}" deleted`));
    }),
  );
