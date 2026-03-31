import { Command } from "commander";
import chalk from "chalk";
import { getAgentSkill } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const viewCommand = new Command()
  .name("view")
  .description("View a custom skill")
  .argument("<name>", "Skill name")
  .option("--agent <id>", "Agent ID (defaults to $ZERO_AGENT_ID)")
  .addHelpText(
    "after",
    `
Examples:
  zero skill view my-skill
  zero skill view my-skill --agent <id>`,
  )
  .action(
    withErrorHandler(async (name: string, options: { agent?: string }) => {
      const agentId = options.agent ?? process.env.ZERO_AGENT_ID;
      if (!agentId) {
        throw new Error(
          "Agent ID required: use --agent <id> or set $ZERO_AGENT_ID",
        );
      }

      const skill = await getAgentSkill(agentId, name);

      console.log(chalk.bold(skill.name));
      if (skill.displayName) console.log(chalk.dim(skill.displayName));
      console.log();
      console.log(`Name:         ${skill.name}`);
      if (skill.displayName) console.log(`Display Name: ${skill.displayName}`);
      if (skill.description) console.log(`Description:  ${skill.description}`);

      console.log();
      if (skill.content) {
        console.log(chalk.dim("── SKILL.md ──"));
        console.log(skill.content);
      } else {
        console.log(chalk.dim("No content"));
      }
    }),
  );
