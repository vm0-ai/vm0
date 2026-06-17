import { Command } from "commander";
import chalk from "chalk";
import { createWorkflow } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { readSkillDirectory } from "../../../lib/skill-directory";

export const createCommand = new Command()
  .name("create")
  .description("Create a workflow in the organization")
  .argument("<name>", "Workflow name (lowercase alphanumeric with hyphens)")
  .requiredOption("--dir <path>", "Path to directory containing SKILL.md")
  .option("--display-name <name>", "Workflow display name")
  .option("--description <text>", "Workflow description")
  .option("--public", "Create as an org-public workflow")
  .addHelpText(
    "after",
    `
Examples:
  zero workflow create my-workflow --dir ./workflows/my-workflow/
  zero workflow create my-workflow --dir ./workflows/my-workflow/ --display-name "My Workflow" --description "Does things"
  zero workflow create shared-workflow --dir ./workflows/shared-workflow/ --public

Notes:
  - A workflow is backed by a skill directory; the directory must contain a root SKILL.md file
  - All files in the directory are uploaded (hidden files and node_modules excluded)
  - New workflows are private by default
  - Use 'zero workflow attach <name> --agent <agent-id>' to attach a workflow to an agent`,
  )
  .action(
    withErrorHandler(
      async (
        name: string,
        options: {
          dir: string;
          displayName?: string;
          description?: string;
          public?: boolean;
        },
      ) => {
        const files = readSkillDirectory(options.dir);

        const workflow = await createWorkflow({
          name,
          files,
          displayName: options.displayName,
          description: options.description,
          visibility: options.public ? "public" : undefined,
        });

        console.log(chalk.green(`✓ Workflow "${workflow.name}" created`));
        console.log(`  Name:         ${workflow.name}`);
        console.log(`  Visibility:   ${workflow.visibility}`);
        console.log(`  Files:        ${files.length} file(s)`);
        if (workflow.displayName) {
          console.log(`  Display Name: ${workflow.displayName}`);
        }
        if (workflow.description) {
          console.log(`  Description:  ${workflow.description}`);
        }
        console.log();
        console.log(
          `Attach to an agent: zero workflow attach ${workflow.name} --agent <agent-id>`,
        );
      },
    ),
  );
