import { Command } from "commander";
import chalk from "chalk";
import { getZeroAgent, getZeroAgentInstructions } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const viewCommand = new Command()
  .name("view")
  .description("View a zero agent")
  .argument("<name>", "Agent name")
  .option("--instructions", "Also show instructions content")
  .action(
    withErrorHandler(
      async (name: string, options: { instructions?: boolean }) => {
        const agent = await getZeroAgent(name);

        console.log(chalk.bold(agent.name));
        if (agent.displayName) console.log(chalk.dim(agent.displayName));
        console.log();
        console.log(`Compose ID:   ${agent.agentComposeId}`);
        console.log(`Connectors:   ${agent.connectors.join(", ") || "-"}`);
        if (agent.description)
          console.log(`Description:  ${agent.description}`);
        if (agent.sound) console.log(`Sound:        ${agent.sound}`);

        if (options.instructions) {
          console.log();
          const result = await getZeroAgentInstructions(name);
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
