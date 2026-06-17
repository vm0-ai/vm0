import { Command } from "commander";
import chalk from "chalk";
import { getWorkflow } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const viewCommand = new Command()
  .name("view")
  .description("View a workflow")
  .argument("<name>", "Workflow name")
  .addHelpText(
    "after",
    `
Examples:
  zero workflow view my-workflow`,
  )
  .action(
    withErrorHandler(async (name: string) => {
      const workflow = await getWorkflow(name);

      console.log(chalk.bold(workflow.name));
      if (workflow.displayName) console.log(chalk.dim(workflow.displayName));
      console.log();
      console.log(`Name:         ${workflow.name}`);
      console.log(`Visibility:   ${workflow.visibility}`);
      if (workflow.displayName)
        console.log(`Display Name: ${workflow.displayName}`);
      if (workflow.description)
        console.log(`Description:  ${workflow.description}`);
      if (workflow.attachedAgents.length > 0) {
        console.log(
          `Agents:       ${workflow.attachedAgents
            .map((agent) => {
              return agent.displayName
                ? `${agent.displayName} (${agent.agentId})`
                : agent.agentId;
            })
            .join(", ")}`,
        );
      }

      if (workflow.files && workflow.files.length > 0) {
        console.log();
        console.log(chalk.dim("── Files ──"));
        for (const f of workflow.files) {
          console.log(`  ${f.path} (${f.size} bytes)`);
        }
      }

      console.log();
      if (workflow.content) {
        console.log(chalk.dim("── SKILL.md ──"));
        console.log(workflow.content);
      } else {
        console.log(chalk.dim("No content"));
      }
    }),
  );
