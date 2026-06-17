import { Command } from "commander";
import chalk from "chalk";
import { detachWorkflowFromAgent } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const detachCommand = new Command()
  .name("detach")
  .description("Detach a workflow from an agent")
  .argument("<name>", "Workflow name")
  .requiredOption("--agent <agent-id>", "Agent ID")
  .addHelpText(
    "after",
    `
Examples:
  zero workflow detach my-workflow --agent <agent-id>`,
  )
  .action(
    withErrorHandler(async (name: string, options: { agent: string }) => {
      const workflow = await detachWorkflowFromAgent(name, options.agent);
      console.log(
        chalk.green(
          `✓ Workflow "${workflow.name}" detached from agent "${options.agent}"`,
        ),
      );
      console.log(`  Attached agents: ${workflow.attachedAgentCount}`);
    }),
  );
