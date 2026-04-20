import { Command } from "commander";
import chalk from "chalk";
import { updateSkill } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { readSkillDirectory } from "../../../lib/skill-directory";

export const editCommand = new Command()
  .name("edit")
  .description("Update a custom skill's content")
  .argument("<name>", "Skill name")
  .requiredOption(
    "--dir <path>",
    "Path to directory containing updated skill files",
  )
  .addHelpText(
    "after",
    `
Examples:
  zero skill edit my-skill --dir ./skills/my-skill/`,
  )
  .action(
    withErrorHandler(async (name: string, options: { dir: string }) => {
      const files = readSkillDirectory(options.dir);
      await updateSkill(name, { files });

      console.log(
        chalk.green(`✓ Skill "${name}" updated (${files.length} file(s))`),
      );
    }),
  );
