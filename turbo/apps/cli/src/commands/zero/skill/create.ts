import { Command } from "commander";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { createAgentSkill } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const createCommand = new Command()
  .name("create")
  .description("Create a custom skill for a zero agent")
  .argument("<name>", "Skill name (lowercase alphanumeric with hyphens)")
  .requiredOption("--dir <path>", "Path to directory containing SKILL.md")
  .option("--agent <id>", "Agent ID (defaults to $ZERO_AGENT_ID)")
  .option("--display-name <name>", "Skill display name")
  .option("--description <text>", "Skill description")
  .addHelpText(
    "after",
    `
Examples:
  zero skill create my-skill --dir ./skills/my-skill/
  zero skill create my-skill --dir ./skills/my-skill/ --agent <id>
  zero skill create my-skill --dir ./skills/my-skill/ --display-name "My Skill" --description "Does things"

Notes:
  - The directory must contain a SKILL.md file
  - Agent ID defaults to $ZERO_AGENT_ID if --agent is not provided`,
  )
  .action(
    withErrorHandler(
      async (
        name: string,
        options: {
          dir: string;
          agent?: string;
          displayName?: string;
          description?: string;
        },
      ) => {
        const agentId = options.agent ?? process.env.ZERO_AGENT_ID;
        if (!agentId) {
          throw new Error(
            "Agent ID required: use --agent <id> or set $ZERO_AGENT_ID",
          );
        }

        const skillMdPath = join(options.dir, "SKILL.md");
        if (!existsSync(skillMdPath)) {
          throw new Error(`SKILL.md not found in ${options.dir}`);
        }

        const content = readFileSync(skillMdPath, "utf-8");

        const skill = await createAgentSkill(agentId, {
          name,
          content,
          displayName: options.displayName,
          description: options.description,
        });

        console.log(chalk.green(`✓ Skill "${skill.name}" created`));
        console.log(`  Name:         ${skill.name}`);
        console.log(`  Agent:        ${agentId}`);
        if (skill.displayName) {
          console.log(`  Display Name: ${skill.displayName}`);
        }
        if (skill.description) {
          console.log(`  Description:  ${skill.description}`);
        }
      },
    ),
  );
