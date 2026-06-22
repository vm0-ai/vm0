import { Command } from "commander";
import chalk from "chalk";
import { runWorkflow } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { resolveWorkflowRef } from "./ref";

export const runCommand = new Command()
  .name("run")
  .description("Run a workflow once in a new chat thread")
  .argument("<workflow>", "Workflow ID or name")
  .option("--agent <agent>", "Agent ID or name to resolve workflow names")
  .addHelpText(
    "after",
    `
Examples:
  zero workflow run <workflow-id>
  zero workflow run <workflow-name>
  zero workflow run <workflow-name> --agent <agent-id-or-name>`,
  )
  .action(
    withErrorHandler(
      async (workflowRef: string, options: { agent?: string }) => {
        const workflowId = await resolveWorkflowRef(workflowRef, {
          agent: options.agent,
        });
        const result = await runWorkflow(workflowId);

        console.log(chalk.green("✓ Workflow run started"));
        console.log(`  Run ID:        ${result.runId}`);
        console.log(`  Chat Thread:   ${result.chatThreadId}`);
        console.log();
        console.log(`Stream logs: zero logs ${result.runId}`);
      },
    ),
  );
