import { Command } from "commander";
import { readFileSync } from "node:fs";
import chalk from "chalk";
import {
  createZeroAgent,
  setZeroAgentUserConnectors,
  updateZeroAgentInstructions,
} from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const createCommand = new Command()
  .name("create")
  .description("Create a new zero agent")
  .option(
    "--connectors <items>",
    "Comma-separated connector types to enable for this agent (e.g. github,linear)",
  )
  .option(
    "--skills <items>",
    "Comma-separated custom skill names to attach (e.g. my-skill,other-skill)",
  )
  .option("--display-name <name>", "Agent display name")
  .option("--description <text>", "Agent description")
  .option(
    "--sound <tone>",
    "Agent tone: professional, friendly, direct, supportive",
  )
  .option("--instructions-file <path>", "Path to instructions file")
  .addHelpText(
    "after",
    `
Examples:
  Minimal:               zero agent create --display-name "My Agent"
  With connectors:       zero agent create --connectors github,linear --display-name "My Agent"
  With skills:           zero agent create --skills my-skill,other-skill --display-name "My Agent"
  With instructions:     zero agent create --connectors github --instructions-file ./instructions.md`,
  )
  .action(
    withErrorHandler(
      async (options: {
        connectors?: string;
        skills?: string;
        displayName?: string;
        description?: string;
        sound?: string;
        instructionsFile?: string;
      }) => {
        const customSkills = options.skills
          ? options.skills.split(",").map((s) => s.trim())
          : undefined;

        const agent = await createZeroAgent({
          displayName: options.displayName,
          description: options.description,
          sound: options.sound,
          customSkills,
        });

        if (options.connectors) {
          const connectors = options.connectors.split(",").map((s) => s.trim());
          await setZeroAgentUserConnectors(agent.agentId, connectors);
        }

        if (options.instructionsFile) {
          const content = readFileSync(options.instructionsFile, "utf-8");
          await updateZeroAgentInstructions(agent.agentId, content);
        }

        console.log(chalk.green(`✓ Agent "${agent.agentId}" created`));
        console.log(`  Agent ID:     ${agent.agentId}`);
        if (options.connectors) {
          console.log(`  Connectors:   ${options.connectors}`);
        }
        if (customSkills?.length) {
          console.log(`  Skills:       ${customSkills.join(", ")}`);
        }
        if (agent.displayName) {
          console.log(`  Display Name: ${agent.displayName}`);
        }
      },
    ),
  );
