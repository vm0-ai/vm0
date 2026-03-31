import { Command } from "commander";
import chalk from "chalk";
import { getAgentSkill, deleteAgentSkill } from "../../../lib/api";
import { isInteractive, promptConfirm } from "../../../lib/utils/prompt-utils";
import { withErrorHandler } from "../../../lib/command";

export const deleteCommand = new Command()
  .name("delete")
  .alias("rm")
  .description("Delete a custom skill")
  .argument("<name>", "Skill name")
  .option("--agent <id>", "Agent ID (defaults to $ZERO_AGENT_ID)")
  .option("-y, --yes", "Skip confirmation prompt")
  .addHelpText(
    "after",
    `
Examples:
  zero skill delete my-skill
  zero skill delete my-skill -y
  zero skill delete my-skill --agent <id>

Notes:
  - Use -y to skip confirmation in non-interactive mode`,
  )
  .action(
    withErrorHandler(
      async (name: string, options: { agent?: string; yes?: boolean }) => {
        const agentId = options.agent ?? process.env.ZERO_AGENT_ID;
        if (!agentId) {
          throw new Error(
            "Agent ID required: use --agent <id> or set $ZERO_AGENT_ID",
          );
        }

        await getAgentSkill(agentId, name);

        if (!options.yes) {
          if (!isInteractive()) {
            throw new Error("--yes flag is required in non-interactive mode");
          }
          const confirmed = await promptConfirm(
            `Delete skill '${name}'?`,
            false,
          );
          if (!confirmed) {
            console.log(chalk.dim("Cancelled"));
            return;
          }
        }

        await deleteAgentSkill(agentId, name);
        console.log(chalk.green(`✓ Skill "${name}" deleted`));
      },
    ),
  );
