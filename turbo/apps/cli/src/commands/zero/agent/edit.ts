import { Command } from "commander";
import { readFileSync } from "node:fs";
import chalk from "chalk";
import {
  getZeroAgent,
  updateZeroAgent,
  updateZeroAgentInstructions,
} from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const editCommand = new Command()
  .name("edit")
  .description("Edit a zero agent")
  .argument("<agent-id>", "Agent ID")
  .option("--display-name <name>", "New display name")
  .option("--description <text>", "New description")
  .option(
    "--sound <tone>",
    "New tone: professional, friendly, direct, supportive",
  )
  .option("--instructions-file <path>", "Path to new instructions file")
  .addHelpText(
    "after",
    `
Examples:
  Update description:      zero agent edit <agent-id> --description "new role"
  Update tone:             zero agent edit <agent-id> --sound friendly
  Update instructions:     zero agent edit <agent-id> --instructions-file ./instructions.md
  Update yourself:         zero agent edit $ZERO_AGENT_ID --description "new role"

Notes:
  - At least one option is required
  - Unspecified fields are preserved (not cleared)`,
  )
  .action(
    withErrorHandler(
      async (
        agentId: string,
        options: {
          displayName?: string;
          description?: string;
          sound?: string;
          instructionsFile?: string;
        },
      ) => {
        const hasAgentUpdate =
          options.displayName !== undefined ||
          options.description !== undefined ||
          options.sound !== undefined;

        if (!hasAgentUpdate && !options.instructionsFile) {
          throw new Error(
            "At least one option is required (--display-name, --description, --sound, --instructions-file)",
          );
        }

        if (hasAgentUpdate) {
          const current = await getZeroAgent(agentId);

          await updateZeroAgent(agentId, {
            displayName:
              options.displayName !== undefined
                ? options.displayName
                : (current.displayName ?? undefined),
            description:
              options.description !== undefined
                ? options.description
                : (current.description ?? undefined),
            sound:
              options.sound !== undefined
                ? options.sound
                : (current.sound ?? undefined),
          });
        }

        if (options.instructionsFile) {
          const content = readFileSync(options.instructionsFile, "utf-8");
          await updateZeroAgentInstructions(agentId, content);
        }

        console.log(chalk.green(`✓ Agent "${agentId}" updated`));
      },
    ),
  );
