import { Command } from "commander";
import chalk from "chalk";
import { listScopes } from "../../lib/api";
import { setScope, clearScope } from "../../lib/api/config";

export const useCommand = new Command()
  .name("use")
  .description("Switch to a different scope")
  .argument("[slug]", "The scope slug to use (omit for personal scope)")
  .action(async (slug?: string) => {
    try {
      // If no slug provided, switch to personal scope
      if (!slug) {
        await clearScope();
        console.log(chalk.green("✓ Switched to personal scope"));
        return;
      }

      // Verify the scope exists and user has access
      const scopes = await listScopes();
      const targetScope = scopes.find((s) => s.slug === slug);

      if (!targetScope) {
        console.error(
          chalk.red(`✗ Scope "${slug}" not found or not accessible.`),
        );
        console.error();
        console.error("Available scopes:");
        for (const scope of scopes) {
          console.error(chalk.cyan(`  - ${scope.slug}`));
        }
        process.exit(1);
      }

      // Save the scope to config
      await setScope(slug);

      const typeTag =
        targetScope.type === "organization"
          ? chalk.blue("(organization)")
          : chalk.dim("(personal)");

      console.log(chalk.green(`✓ Switched to scope: ${slug} ${typeTag}`));
      console.log();
      console.log("All subsequent commands will operate within this scope.");
      console.log();
      console.log("To switch back to personal scope:");
      console.log(chalk.cyan("  vm0 scope use"));
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
