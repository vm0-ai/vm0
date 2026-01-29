import { Command } from "commander";
import chalk from "chalk";
import {
  installAllClaudeSkills,
  handleFetchError,
  SKILLS,
  PRIMARY_SKILL_NAME,
} from "../lib/domain/onboard/index.js";

export const setupClaudeCommand = new Command()
  .name("setup-claude")
  .description("Add/update Claude skills for VM0 usage")
  .option(
    "--agent-dir <dir>",
    "Agent directory (shown in next step instructions)",
  )
  .action(async (options: { agentDir?: string }) => {
    console.log(chalk.dim("Installing Claude skills..."));

    try {
      const result = await installAllClaudeSkills();
      result.skills.forEach((skillResult, i) => {
        const skillName = SKILLS[i]?.name ?? "unknown";
        console.log(
          chalk.green(
            `✓ Installed ${skillName} skill to ${skillResult.skillDir}`,
          ),
        );
      });
    } catch (error) {
      handleFetchError(error);
    }

    console.log();
    console.log("Next step:");
    const cdPrefix = options.agentDir ? `cd ${options.agentDir} && ` : "";
    console.log(
      chalk.cyan(
        `  ${cdPrefix}claude "/${PRIMARY_SKILL_NAME} let's build a workflow"`,
      ),
    );
  });
