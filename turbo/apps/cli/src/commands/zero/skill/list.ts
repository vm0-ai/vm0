import { Command } from "commander";
import chalk from "chalk";
import { listAgentSkills } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List custom skills for a zero agent")
  .option("--agent <id>", "Agent ID (defaults to $ZERO_AGENT_ID)")
  .addHelpText(
    "after",
    `
Examples:
  zero skill list
  zero skill list --agent <id>`,
  )
  .action(
    withErrorHandler(async (options: { agent?: string }) => {
      const agentId = options.agent ?? process.env.ZERO_AGENT_ID;
      if (!agentId) {
        throw new Error(
          "Agent ID required: use --agent <id> or set $ZERO_AGENT_ID",
        );
      }

      const skills = await listAgentSkills(agentId);

      if (skills.length === 0) {
        console.log(chalk.dim("No custom skills found"));
        console.log(
          chalk.dim("  Create one with: zero skill create <name> --dir <path>"),
        );
        return;
      }

      const nameWidth = Math.max(4, ...skills.map((s) => s.name.length));
      const displayWidth = Math.max(
        12,
        ...skills.map((s) => (s.displayName ?? "").length),
      );

      const header = [
        "NAME".padEnd(nameWidth),
        "DISPLAY NAME".padEnd(displayWidth),
        "DESCRIPTION",
      ].join("  ");
      console.log(chalk.dim(header));

      for (const skill of skills) {
        const row = [
          skill.name.padEnd(nameWidth),
          (skill.displayName ?? "-").padEnd(displayWidth),
          skill.description ?? "-",
        ].join("  ");
        console.log(row);
      }
    }),
  );
