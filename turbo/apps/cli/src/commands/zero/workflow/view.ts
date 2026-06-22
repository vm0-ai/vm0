import { Command } from "commander";
import chalk from "chalk";
import { getWorkflow } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const viewCommand = new Command()
  .name("view")
  .description("View a workflow")
  .argument("<workflowId>", "Workflow ID")
  .addHelpText(
    "after",
    `
Examples:
  zero workflow view <workflow-id>`,
  )
  .action(
    withErrorHandler(async (workflowId: string) => {
      const workflow = await getWorkflow(workflowId);

      console.log(chalk.bold(workflow.name));
      if (workflow.displayName) console.log(chalk.dim(workflow.displayName));
      console.log();
      console.log(`ID:           ${workflow.id}`);
      console.log(`Name:         ${workflow.name}`);
      console.log(`Visibility:   ${workflow.visibility}`);
      console.log(
        `Agent:        ${workflow.agentName ?? workflow.agentId} (${workflow.agentId})`,
      );
      if (workflow.displayName)
        console.log(`Display Name: ${workflow.displayName}`);
      if (workflow.description)
        console.log(`Description:  ${workflow.description}`);

      if (workflow.files && workflow.files.length > 0) {
        console.log();
        console.log(chalk.dim("── Files ──"));
        for (const f of workflow.files) {
          console.log(`  ${f.path} (${f.size} bytes)`);
        }
      }

      console.log();
      if (workflow.instruction) {
        console.log(chalk.dim("── Instruction ──"));
        console.log(workflow.instruction);
      } else {
        console.log(chalk.dim("No instruction"));
      }
    }),
  );
