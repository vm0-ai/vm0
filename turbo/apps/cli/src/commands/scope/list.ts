import { Command } from "commander";
import chalk from "chalk";
import { listScopes } from "../../lib/api";
import { getScope as getConfigScope } from "../../lib/api/config";

export const listCommand = new Command()
  .name("list")
  .description("List all accessible scopes")
  .action(async () => {
    try {
      const scopes = await listScopes();
      const currentScope = await getConfigScope();

      console.log(chalk.bold("Accessible Scopes:"));
      console.log();

      for (const scope of scopes) {
        const isCurrent = currentScope === scope.slug;
        const marker = isCurrent ? chalk.green("* ") : "  ";
        const typeTag =
          scope.type === "organization"
            ? chalk.blue("(org)")
            : chalk.dim("(personal)");
        const roleTag =
          scope.role === "owner"
            ? chalk.yellow(" owner")
            : scope.role === "member"
              ? chalk.dim(" member")
              : "";

        console.log(`${marker}${scope.slug} ${typeTag}${roleTag}`);
      }

      console.log();
      if (currentScope) {
        console.log(chalk.dim(`Current scope: ${currentScope}`));
      } else {
        console.log(chalk.dim("Using personal scope (default)"));
      }
      console.log();
      console.log("To switch scope:");
      console.log(chalk.cyan("  vm0 scope use <slug>"));
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes("Not authenticated")) {
          console.error(chalk.red("✗ Not authenticated. Run: vm0 auth login"));
        } else {
          console.error(chalk.red(`✗ ${error.message}`));
        }
      } else {
        console.error(chalk.red("✗ An unexpected error occurred"));
      }
      process.exit(1);
    }
  });
