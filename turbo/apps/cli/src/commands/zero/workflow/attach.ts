import { Command } from "commander";
import chalk from "chalk";
import { attachWorkflowToAgent } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const attachCommand = new Command()
  .name("attach")
  .description("Attach a workflow to an agent")
  .argument("<name>", "Workflow name")
  .requiredOption("--agent <agent-id>", "Agent ID")
  .addHelpText(
    "after",
    `
Examples:
  zero workflow attach my-workflow --agent <agent-id>`,
  )
  .action(
    withErrorHandler(async (name: string, options: { agent: string }) => {
      const workflow = await attachWorkflowToAgent(name, options.agent);
      console.log(
        chalk.green(
          `✓ Workflow "${workflow.name}" attached to agent "${options.agent}"`,
        ),
      );
      console.log(`  Attached agents: ${workflow.attachedAgentCount}`);
    }),
  );
