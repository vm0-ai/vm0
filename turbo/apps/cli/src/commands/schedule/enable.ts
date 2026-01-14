import { Command } from "commander";
import chalk from "chalk";
import { apiClient, type ApiError } from "../../lib/api/api-client";
import { loadAgentName } from "../../lib/domain/schedule-utils";

export const enableCommand = new Command()
  .name("enable")
  .description("Enable a schedule")
  .argument("<name>", "Schedule name to enable")
  .action(async (name: string) => {
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

      // Call API - enable/disable use body with composeId
      const response = await apiClient.post(
        `/api/agent/schedules/${encodeURIComponent(name)}/enable`,
        { body: JSON.stringify({ composeId }) },
      );

      if (!response.ok) {
        const error = (await response.json()) as ApiError;
        throw new Error(error.error?.message || "Enable failed");
      }

      console.log(chalk.green(`✓ Enabled schedule ${chalk.cyan(name)}`));
    } catch (error) {
      console.error(chalk.red("✗ Failed to enable schedule"));
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
