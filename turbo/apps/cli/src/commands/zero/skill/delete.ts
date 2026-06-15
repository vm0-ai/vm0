import { Command } from "commander";
import chalk from "chalk";
import { getSkill, deleteSkill } from "../../../lib/api";
import { isInteractive, promptConfirm } from "../../../lib/utils/prompt-utils";
import { withErrorHandler } from "../../../lib/command";

export const deleteCommand = new Command()
  .name("delete")
  .alias("rm")
  .description("Delete a custom skill from the organization")
  .argument("<name>", "Skill name")
  .option("-y, --yes", "Skip confirmation prompt")
  .addHelpText(
    "after",
    `
Examples:
  zero skill delete my-skill
  zero skill delete my-skill -y

Notes:
  - This removes the skill from the organization and unbinds it from all agents
  - Use -y to skip confirmation in non-interactive mode`,
  )
  .action(
    withErrorHandler(async (name: string, options: { yes?: boolean }) => {
      await getSkill(name);

      if (!options.yes) {
        if (!isInteractive()) {
          throw new Error("--yes flag is required in non-interactive mode");
        }
        const confirmed = await promptConfirm(
          `Delete skill '${name}'? This will unbind it from all agents.`,
          false,
        );
        if (!confirmed) {
          console.log(chalk.dim("Cancelled"));
          return;
        }
      }

      await deleteSkill(name);
      console.log(chalk.green(`✓ Skill "${name}" deleted`));
    }),
  );
