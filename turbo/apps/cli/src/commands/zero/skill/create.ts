import { Command } from "commander";
import chalk from "chalk";
import { createSkill } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { readSkillDirectory } from "../../../lib/skill-directory";

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
  - All files in the directory are uploaded (hidden files and node_modules excluded)
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
        const files = readSkillDirectory(options.dir);

        const skill = await createSkill({
          name,
          files,
          displayName: options.displayName,
          description: options.description,
        });

        console.log(chalk.green(`✓ Skill "${skill.name}" created`));
        console.log(`  Name:         ${skill.name}`);
        console.log(`  Files:        ${files.length} file(s)`);
        if (skill.displayName) {
          console.log(`  Display Name: ${skill.displayName}`);
        }
        if (skill.description) {
          console.log(`  Description:  ${skill.description}`);
        }
      },
    ),
  );
