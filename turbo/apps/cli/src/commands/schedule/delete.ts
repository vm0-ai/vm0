import { Command } from "commander";
import chalk from "chalk";
import * as readline from "readline";
import { apiClient, type ApiError } from "../../lib/api/api-client";
import { loadAgentName } from "../../lib/domain/schedule-utils";

/**
 * Prompt for confirmation
 */
async function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${message} (y/N) `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

export const deleteCommand = new Command()
  .name("delete")
  .alias("rm")
  .description("Delete a schedule")
  .argument("<name>", "Schedule name to delete")
  .option("-f, --force", "Skip confirmation prompt")
  .action(async (name: string, options: { force?: boolean }) => {
    try {
      // Load vm0.yaml to get agent name
      const result = loadAgentName();
      if (result.error) {
        console.error(chalk.red(`✗ Invalid vm0.yaml: ${result.error}`));
        process.exit(1);
      }
      if (!result.agentName) {
        console.error(chalk.red("✗ No vm0.yaml found in current directory"));
        console.error(chalk.dim("  Run this command from the agent directory"));
        process.exit(1);
      }
      const agentName = result.agentName;

      // Get compose ID
      let composeId: string;
      try {
        const compose = await apiClient.getComposeByName(agentName);
        composeId = compose.id;
      } catch {
        console.error(chalk.red(`✗ Agent not found: ${agentName}`));
        console.error(chalk.dim("  Make sure the agent is pushed first"));
        process.exit(1);
      }

      // Confirm deletion
      if (!options.force) {
        const confirmed = await confirm(`Delete schedule ${chalk.cyan(name)}?`);
        if (!confirmed) {
          console.log(chalk.dim("Cancelled"));
          return;
        }
      }

      // Call API
      const response = await apiClient.delete(
        `/api/agent/schedules/${encodeURIComponent(name)}?composeId=${encodeURIComponent(composeId)}`,
      );

      if (!response.ok) {
        const error = (await response.json()) as ApiError;
        throw new Error(error.error?.message || "Delete failed");
      }

      console.log(chalk.green(`✓ Deleted schedule ${chalk.cyan(name)}`));
    } catch (error) {
      console.error(chalk.red("✗ Failed to delete schedule"));
      if (error instanceof Error) {
        if (error.message.includes("Not authenticated")) {
          console.error(chalk.dim("  Run: vm0 auth login"));
        } else {
          console.error(chalk.dim(`  ${error.message}`));
        }
      }
      process.exit(1);
    }
  });
