import { Command } from "commander";
import chalk from "chalk";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import {
  fetchSkillContent,
  SKILL_DIR,
  SKILL_NAME,
  SKILL_URL,
} from "../lib/domain/onboard/index.js";

export const setupClaudeCommand = new Command()
  .name("setup-claude")
  .description("Add/update Claude skill for VM0 CLI usage")
  .option(
    "--agent-dir <dir>",
    "Agent directory (shown in next step instructions)",
  )
  .action(async (options: { agentDir?: string }) => {
    console.log(chalk.dim(`Installing ${SKILL_NAME} skill...`));

    let content: string;
    try {
      content = await fetchSkillContent();
    } catch (error) {
      console.error(
        chalk.red(`Failed to fetch skill from GitHub: ${SKILL_URL}`),
      );
      if (error instanceof Error) {
        console.error(chalk.red(error.message));
      }
      console.error(chalk.dim("Please check your network connection."));
      process.exit(1);
    }

    // Create directory
    await mkdir(SKILL_DIR, { recursive: true });

    // Write skill file
    await writeFile(path.join(SKILL_DIR, "SKILL.md"), content);

    console.log(
      chalk.green(`Done! Installed ${SKILL_NAME} skill to ${SKILL_DIR}`),
    );
    console.log();
    console.log("Next step:");
    const cdPrefix = options.agentDir ? `cd ${options.agentDir} && ` : "";
    console.log(
      chalk.cyan(
        `  ${cdPrefix}claude "/${SKILL_NAME} I want to build an agent that..."`,
      ),
    );
  });
