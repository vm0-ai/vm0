import { Command } from "commander";
import chalk from "chalk";
import { setWorkflowAgents } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

function parseAgentIds(value: string): string[] {
  return value
    .split(",")
    .map((item) => {
      return item.trim();
    })
    .filter((item) => {
      return item.length > 0;
    });
}

export const setAgentsCommand = new Command()
  .name("set-agents")
  .description("Replace all agent attachments for a workflow")
  .argument("<name>", "Workflow name")
  .requiredOption("--agents <agent-ids>", "Comma-separated agent IDs")
  .addHelpText(
    "after",
    `
Examples:
  zero workflow set-agents my-workflow --agents <agent-id>,<agent-id>
  zero workflow set-agents my-workflow --agents ""`,
  )
  .action(
    withErrorHandler(async (name: string, options: { agents: string }) => {
      const agentIds = parseAgentIds(options.agents);
      const workflow = await setWorkflowAgents(name, agentIds);
      console.log(
        chalk.green(`✓ Workflow "${workflow.name}" agent attachments updated`),
      );
      console.log(`  Attached agents: ${workflow.attachedAgentCount}`);
    }),
  );
