import { Command } from "commander";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { updateSkill } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const editCommand = new Command()
  .name("edit")
  .description("Update a custom skill's content")
  .argument("<name>", "Skill name")
  .requiredOption(
    "--dir <path>",
    "Path to directory containing updated SKILL.md",
  )
  .addHelpText(
    "after",
    `
Examples:
  zero skill edit my-skill --dir ./skills/my-skill/`,
  )
  .action(
    withErrorHandler(async (name: string, options: { dir: string }) => {
      const skillMdPath = join(options.dir, "SKILL.md");
      if (!existsSync(skillMdPath)) {
        throw new Error(`SKILL.md not found in ${options.dir}`);
      }

      const content = readFileSync(skillMdPath, "utf-8");
      await updateSkill(name, { content });

      console.log(chalk.green(`✓ Skill "${name}" updated`));
    }),
  );
