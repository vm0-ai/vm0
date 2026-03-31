import { Command } from "commander";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { createSkill } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const createCommand = new Command()
  .name("create")
  .description("Create a custom skill in the organization")
  .argument("<name>", "Skill name (lowercase alphanumeric with hyphens)")
  .requiredOption("--dir <path>", "Path to directory containing SKILL.md")
  .option("--display-name <name>", "Skill display name")
  .option("--description <text>", "Skill description")
  .addHelpText(
    "after",
    `
Examples:
  zero skill create my-skill --dir ./skills/my-skill/
  zero skill create my-skill --dir ./skills/my-skill/ --display-name "My Skill" --description "Does things"

Notes:
  - The directory must contain a SKILL.md file
  - The skill is created in the organization but not bound to any agent
  - Use 'zero agent edit <id> --add-skill <name>' to bind a skill to an agent`,
  )
  .action(
    withErrorHandler(
      async (
        name: string,
        options: {
          dir: string;
          displayName?: string;
          description?: string;
        },
      ) => {
        const skillMdPath = join(options.dir, "SKILL.md");
        if (!existsSync(skillMdPath)) {
          throw new Error(`SKILL.md not found in ${options.dir}`);
        }

        const content = readFileSync(skillMdPath, "utf-8");

        const skill = await createSkill({
          name,
          content,
          displayName: options.displayName,
          description: options.description,
        });

        console.log(chalk.green(`✓ Skill "${skill.name}" created`));
        console.log(`  Name:         ${skill.name}`);
        if (skill.displayName) {
          console.log(`  Display Name: ${skill.displayName}`);
        }
        if (skill.description) {
          console.log(`  Description:  ${skill.description}`);
        }
      },
    ),
  );
