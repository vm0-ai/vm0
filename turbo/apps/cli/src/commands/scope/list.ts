import { Command } from "commander";
import chalk from "chalk";
import { listScopes } from "../../lib/api";
import { loadConfig } from "../../lib/api/config";
import { withErrorHandler } from "../../lib/command";

export const listCommand = new Command()
  .name("list")
  .description("List all accessible scopes")
  .action(
    withErrorHandler(async () => {
      const result = await listScopes();
      const config = await loadConfig();
      const activeScope = config.activeScope;

      console.log(chalk.bold("Available scopes:"));
      for (const scope of result.scopes) {
        const isCurrent = scope.slug === activeScope;
        const marker = isCurrent ? chalk.green("* ") : "  ";
        const roleLabel = scope.role ? ` (${scope.role})` : "";
        const currentLabel = isCurrent ? chalk.dim(" ← current") : "";
        console.log(`${marker}${scope.slug}${roleLabel}${currentLabel}`);
      }
    }),
  );
