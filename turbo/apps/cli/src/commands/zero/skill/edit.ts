import { Command } from "commander";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { updateAgentSkill } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const editCommand = new Command()
  .name("edit")
  .description("Update a custom skill's content")
  .argument("<name>", "Skill name")
  .requiredOption(
    "--dir <path>",
    "Path to directory containing updated SKILL.md",
  )
  .option("--agent <id>", "Agent ID (defaults to $ZERO_AGENT_ID)")
  .addHelpText(
    "after",
    `
Examples:
  zero skill edit my-skill --dir ./skills/my-skill/
  zero skill edit my-skill --dir ./skills/my-skill/ --agent <id>`,
  )
  .action(
    withErrorHandler(
      async (name: string, options: { dir: string; agent?: string }) => {
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
        await updateAgentSkill(agentId, name, { content });

        console.log(chalk.green(`✓ Skill "${name}" updated`));
      },
    ),
  );
