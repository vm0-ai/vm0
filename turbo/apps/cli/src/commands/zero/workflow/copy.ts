import { Command } from "commander";
import chalk from "chalk";
import { copyWorkflow } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { resolveWorkflowRef } from "./ref";

export const copyCommand = new Command()
  .name("copy")
  .description("Copy (fork) a workflow onto another agent")
  .argument("<workflow>", "Workflow ID or name to copy")
  .option("--agent <agent>", "Agent ID or name to resolve workflow names")
  .requiredOption("--to-agent <agent-id>", "Target agent ID")
  .addHelpText(
    "after",
    `
Examples:
  zero workflow copy <workflow-id> --to-agent <agent-id>
  zero workflow copy <workflow-name> --agent <agent-id-or-name> --to-agent <agent-id>`,
  )
  .action(
    withErrorHandler(
      async (
        workflowRef: string,
        options: { agent?: string; toAgent: string },
      ) => {
        const workflowId = await resolveWorkflowRef(workflowRef, {
          agent: options.agent,
        });
        const workflow = await copyWorkflow(workflowId, options.toAgent);

        console.log(chalk.green(`✓ Workflow "${workflow.name}" copied`));
        console.log(`  ID:     ${workflow.id}`);
        console.log(`  Agent:  ${workflow.agentName ?? workflow.agentId}`);
        console.log();
        console.log(`View it: zero workflow view ${workflow.id}`);
      },
    ),
  );
