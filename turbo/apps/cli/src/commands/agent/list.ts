import { Command } from "commander";
import chalk from "chalk";
import { apiClient, type ApiError } from "../../lib/api/api-client";
import { formatRelativeTime } from "../../lib/utils/file-utils";

/**
 * Compose list item from /api/agent/composes/list
 */
interface ComposeListItem {
  name: string;
  headVersionId: string | null;
  updatedAt: string;
}

interface ComposeListResponse {
  composes: ComposeListItem[];
}

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List all agent composes")
  .option("-s, --scope <scope>", "Scope to list composes from")
  .action(async (options: { scope?: string }) => {
    try {
      // Build URL with optional scope parameter
      const url = options.scope
        ? `/api/agent/composes/list?scope=${encodeURIComponent(options.scope)}`
        : "/api/agent/composes/list";

      const response = await apiClient.get(url);

      if (!response.ok) {
        const error = (await response.json()) as ApiError;
        throw new Error(error.error?.message || "List failed");
      }

      const data = (await response.json()) as ComposeListResponse;

      if (data.composes.length === 0) {
        console.log(chalk.dim("No agent composes found"));
        console.log(
          chalk.dim("  Create one with: vm0 compose <agent-compose.yaml>"),
        );
        return;
      }

      // Calculate column widths
      const nameWidth = Math.max(4, ...data.composes.map((c) => c.name.length));

      // Print header
      const header = ["NAME".padEnd(nameWidth), "VERSION", "UPDATED"].join(
        "  ",
      );
      console.log(chalk.dim(header));

      // Print rows
      for (const compose of data.composes) {
        const versionShort = compose.headVersionId
          ? compose.headVersionId.slice(0, 8)
          : chalk.dim("-");
        const row = [
          compose.name.padEnd(nameWidth),
          versionShort,
          formatRelativeTime(compose.updatedAt),
        ].join("  ");
        console.log(row);
      }
    } catch (error) {
      console.error(chalk.red("✗ Failed to list agent composes"));
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
