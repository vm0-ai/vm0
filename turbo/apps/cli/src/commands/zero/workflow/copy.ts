import { Command } from "commander";
import chalk from "chalk";
import { copyWorkflow, listWorkflowAutomations } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { printWorkflowAutomationsTable } from "./automation/display";
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
        console.log();
        console.log(`  ID:           ${workflow.id}`);
        console.log(`  Name:         ${workflow.name}`);
        console.log(`  Visibility:   ${workflow.visibility}`);
        console.log(`  Agent Name:   ${formatWorkflowAgentName(workflow)}`);
        console.log(`  Agent ID:     ${workflow.agentId}`);
        if (workflow.displayName)
          console.log(`  Display Name: ${workflow.displayName}`);
        if (workflow.description)
          console.log(`  Description:  ${workflow.description}`);

        const automations = await listWorkflowAutomations(workflow.id);

        console.log();
        console.log(
          chalk.dim(`── Copied automations (${automations.length}) ──`),
        );
        if (automations.length === 0) {
          console.log(chalk.dim("No automations copied"));
        } else {
          printWorkflowAutomationsTable(automations);
        }
        console.log();
        console.log(`View it: zero workflow view ${workflow.id}`);
      },
    ),
  );
