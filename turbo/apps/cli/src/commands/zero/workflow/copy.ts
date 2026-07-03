import { Command } from "commander";
import chalk from "chalk";
import { copyWorkflow } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { formatWorkflowAgentName } from "./format";
import {
  resolveWorkflowRef,
  type WorkflowRefOptions,
} from "./resolve-workflow-ref";

export const copyCommand = new Command()
  .name("copy")
  .description("Copy (fork) a workflow onto another agent")
  .argument("<workflow>", "Workflow ID or name to copy")
  .option("--agent <id>", "Agent ID for resolving workflow names")
  .requiredOption("--to-agent <agent-id>", "Target agent ID")
  .addHelpText(
    "after",
    `
Examples:
  zero workflow copy tell-a-joke --agent <source-agent-id> --to-agent <target-agent-id>
  zero workflow copy <workflow-id> --to-agent <target-agent-id>`,
  )
  .action(
    withErrorHandler(
      async (
        workflowRef: string,
        options: { toAgent: string } & WorkflowRefOptions,
      ) => {
        const workflowId = await resolveWorkflowRef(workflowRef, options);
        const workflow = await copyWorkflow(workflowId, options.toAgent);

        console.log(chalk.green(`✓ Workflow "${workflow.name}" copied`));
        console.log(`  ID:           ${workflow.id}`);
        console.log(`  Agent Name:   ${formatWorkflowAgentName(workflow)}`);
        console.log(`  Agent ID:     ${workflow.agentId}`);
        console.log();
        console.log(`View it: zero workflow view ${workflow.id}`);
      },
    ),
  );
