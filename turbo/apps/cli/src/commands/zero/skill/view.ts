import { Command } from "commander";
import chalk from "chalk";
import { getSkill } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const viewCommand = new Command()
  .name("view")
  .description("View a custom skill")
  .argument("<name>", "Skill name")
  .addHelpText(
    "after",
    `
Examples:
  zero skill view my-skill`,
  )
  .action(
    withErrorHandler(async (name: string) => {
      const skill = await getSkill(name);

      console.log(chalk.bold(skill.name));
      if (skill.displayName) console.log(chalk.dim(skill.displayName));
      console.log();
      console.log(`Name:         ${skill.name}`);
      if (skill.displayName) console.log(`Display Name: ${skill.displayName}`);
      if (skill.description) console.log(`Description:  ${skill.description}`);

      if (skill.files && skill.files.length > 0) {
        console.log();
        console.log(chalk.dim("── Files ──"));
        for (const f of skill.files) {
          console.log(`  ${f.path} (${f.size} bytes)`);
        }
      }

      console.log();
      if (skill.content) {
        console.log(chalk.dim("── SKILL.md ──"));
        console.log(skill.content);
      } else {
        console.log(chalk.dim("No content"));
      }
    }),
  );
