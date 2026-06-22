import { Command } from "commander";
import chalk from "chalk";
import { copyWorkflow } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const copyCommand = new Command()
  .name("copy")
  .description("Copy (fork) a workflow onto another agent")
  .argument("<workflowId>", "Workflow ID to copy")
  .requiredOption("--to-agent <agent-id>", "Target agent ID")
  .addHelpText(
    "after",
    `
Examples:
  zero workflow copy <workflow-id> --to-agent <agent-id>`,
  )
  .action(
    withErrorHandler(
      async (workflowId: string, options: { toAgent: string }) => {
        const workflow = await copyWorkflow(workflowId, options.toAgent);

        console.log(chalk.green(`✓ Workflow "${workflow.name}" copied`));
        console.log(`  ID:     ${workflow.id}`);
        console.log(`  Agent:  ${workflow.agentName ?? workflow.agentId}`);
        console.log();
        console.log(`View it: zero workflow view ${workflow.id}`);
      },
    ),
  );
