import { Command } from "commander";
import { readFileSync } from "node:fs";
import chalk from "chalk";
import { createZeroAgent, updateZeroAgentInstructions } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const createCommand = new Command()
  .name("create")
  .description("Create a new zero agent")
  .requiredOption(
    "--connectors <items>",
    "Comma-separated connector short names (e.g. github,linear)",
  )
  .option("--display-name <name>", "Agent display name")
  .option("--description <text>", "Agent description")
  .option(
    "--sound <tone>",
    "Agent tone: professional, friendly, direct, supportive",
  )
  .option("--instructions-file <path>", "Path to instructions file")
  .action(
    withErrorHandler(
      async (options: {
        connectors: string;
        displayName?: string;
        description?: string;
        sound?: string;
        instructionsFile?: string;
      }) => {
        const connectors = options.connectors.split(",").map((s) => s.trim());

        const agent = await createZeroAgent({
          connectors,
          displayName: options.displayName,
          description: options.description,
          sound: options.sound,
        });

        if (options.instructionsFile) {
          const content = readFileSync(options.instructionsFile, "utf-8");
          await updateZeroAgentInstructions(agent.agentId, content);
        }

        console.log(chalk.green(`✓ Agent "${agent.agentId}" created`));
        console.log(`  Agent ID:     ${agent.agentId}`);
        console.log(`  Connectors:   ${agent.connectors.join(", ")}`);
        if (agent.displayName) {
          console.log(`  Display Name: ${agent.displayName}`);
        }
      },
    ),
  );
