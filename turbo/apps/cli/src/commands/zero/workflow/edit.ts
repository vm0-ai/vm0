import { Command } from "commander";
import chalk from "chalk";
import { updateWorkflow } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { readSkillDirectory } from "../../../lib/skill-directory";

export const editCommand = new Command()
  .name("edit")
  .description("Update a workflow's content or visibility")
  .argument("<name>", "Workflow name")
  .option("--dir <path>", "Path to directory containing updated workflow files")
  .option("--public", "Make the workflow org-public")
  .option("--private", "Make the workflow private")
  .addHelpText(
    "after",
    `
Examples:
  zero workflow edit my-workflow --dir ./workflows/my-workflow/
  zero workflow edit my-workflow --public
  zero workflow edit my-workflow --private

Notes:
  - Workflow directories must contain a root SKILL.md file
  - At least one of --dir, --public, or --private is required`,
  )
  .action(
    withErrorHandler(
      async (
        name: string,
        options: { dir?: string; public?: boolean; private?: boolean },
      ) => {
        if (options.public && options.private) {
          throw new Error("Cannot use --public and --private together");
        }

        if (!options.dir && !options.public && !options.private) {
          throw new Error(
            "At least one option is required (--dir, --public, or --private)",
          );
        }

        const files = options.dir ? readSkillDirectory(options.dir) : undefined;
        const visibility = options.public
          ? "public"
          : options.private
            ? "private"
            : undefined;

        const workflow = await updateWorkflow(name, { files, visibility });

        console.log(chalk.green(`✓ Workflow "${name}" updated`));
        console.log(`  Visibility:   ${workflow.visibility}`);
        if (files) {
          console.log(`  Files:        ${files.length} file(s)`);
        }
      },
    ),
  );
