import { Command } from "commander";
import chalk from "chalk";
import { listOrgs } from "../../lib/api";
import { loadConfig } from "../../lib/api/config";
import { withErrorHandler } from "../../lib/command";

export const listCommand = new Command()
  .name("list")
  .description("List all accessible organizations")
  .action(
    withErrorHandler(async () => {
      const result = await listOrgs();
      const config = await loadConfig();
      const activeScope = config.activeScope;

      console.log(chalk.bold("Available organizations:"));
      for (const org of result.scopes) {
        const isCurrent = org.slug === activeScope;
        const marker = isCurrent ? chalk.green("* ") : "  ";
        const roleLabel = org.role ? ` (${org.role})` : "";
        const currentLabel = isCurrent ? chalk.dim(" ← current") : "";
        console.log(`${marker}${org.slug}${roleLabel}${currentLabel}`);
      }
    }),
  );
