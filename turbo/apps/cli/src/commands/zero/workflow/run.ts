import { Command } from "commander";
import chalk from "chalk";
import { runWorkflow } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const runCommand = new Command()
  .name("run")
  .description("Run a workflow once in a new chat thread")
  .argument("<workflowId>", "Workflow ID")
  .addHelpText(
    "after",
    `
Examples:
  zero workflow run <workflow-id>`,
  )
  .action(
    withErrorHandler(async (workflowId: string) => {
      const result = await runWorkflow(workflowId);

      console.log(chalk.green("✓ Workflow run started"));
      console.log(`  Run ID:        ${result.runId}`);
      console.log(`  Chat Thread:   ${result.chatThreadId}`);
      console.log();
      console.log(`Stream logs: zero logs ${result.runId}`);
    }),
  );
