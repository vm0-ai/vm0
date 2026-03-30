import { Command } from "commander";
import chalk from "chalk";
import {
  getZeroAgent,
  getZeroAgentInstructions,
  getZeroAgentUserConnectors,
} from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const viewCommand = new Command()
  .name("view")
  .description("View a zero agent")
  .argument("<agent-id>", "Agent ID")
  .option("--instructions", "Also show instructions content")
  .addHelpText(
    "after",
    `
Examples:
  View basic info:         zero agent view <agent-id>
  Include instructions:    zero agent view <agent-id> --instructions
  View yourself:           zero agent view $ZERO_AGENT_ID --instructions`,
  )
  .action(
    withErrorHandler(
      async (agentId: string, options: { instructions?: boolean }) => {
        const agent = await getZeroAgent(agentId);

        console.log(chalk.bold(agent.agentId));
        if (agent.displayName) console.log(chalk.dim(agent.displayName));
        console.log();
        console.log(`Agent ID:     ${agent.agentId}`);
        const connectors = await getZeroAgentUserConnectors(agentId);
        if (connectors.length > 0)
          console.log(`Connectors:   ${connectors.join(", ")}`);
        if (agent.description)
          console.log(`Description:  ${agent.description}`);
        if (agent.sound) console.log(`Sound:        ${agent.sound}`);

        if (options.instructions) {
          console.log();
          const result = await getZeroAgentInstructions(agentId);
          if (result.content) {
            console.log(chalk.dim("── Instructions ──"));
            console.log(result.content);
          } else {
            console.log(chalk.dim("No instructions set"));
          }
        }
      },
    ),
  );
