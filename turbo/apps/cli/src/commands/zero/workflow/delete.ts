import { Command } from "commander";
import chalk from "chalk";
import { deleteWorkflow, getWorkflow } from "../../../lib/api";
import { isInteractive, promptConfirm } from "../../../lib/utils/prompt-utils";
import { withErrorHandler } from "../../../lib/command";

export const deleteCommand = new Command()
  .name("delete")
  .alias("rm")
  .description("Delete a workflow")
  .argument("<workflowId>", "Workflow ID")
  .option("-y, --yes", "Skip confirmation prompt")
  .addHelpText(
    "after",
    `
Examples:
  zero workflow delete <workflow-id>
  zero workflow delete <workflow-id> -y

Notes:
  - Use -y to skip confirmation in non-interactive mode`,
  )
  .action(
    withErrorHandler(async (workflowId: string, options: { yes?: boolean }) => {
      const workflow = await getWorkflow(workflowId);

      if (!options.yes) {
        if (!isInteractive()) {
          throw new Error("--yes flag is required in non-interactive mode");
        }
        const confirmed = await promptConfirm(
          `Delete workflow '${workflow.name}'?`,
          false,
        );
        if (!confirmed) {
          console.log(chalk.dim("Cancelled"));
          return;
        }
      }

      await deleteWorkflow(workflowId);
      console.log(chalk.green(`✓ Workflow "${workflow.name}" deleted`));
    }),
  );
