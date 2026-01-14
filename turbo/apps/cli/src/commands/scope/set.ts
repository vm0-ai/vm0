import { Command } from "commander";
import chalk from "chalk";
import { apiClient } from "../../lib/api/api-client";

export const setCommand = new Command()
  .name("set")
  .description("Set your scope slug")
  .argument("<slug>", "The scope slug (e.g., your username)")
  .option("--force", "Force change existing scope (may break references)")
  .option("--display-name <name>", "Display name for the scope")
  .action(
    async (
      slug: string,
      options: { force?: boolean; displayName?: string },
    ) => {
      try {
        // First check if user already has a scope
        let existingScope;
        try {
          existingScope = await apiClient.getScope();
        } catch (error) {
          // Only swallow "No scope configured" errors - that's the expected case for new users
          // All other errors (network, auth, etc.) should propagate to the outer handler
          if (
            !(error instanceof Error) ||
            !error.message.includes("No scope configured")
          ) {
            throw error;
          }
        }

        let scope;
        if (existingScope) {
          // User already has a scope - update it
          if (!options.force) {
            console.error(
              chalk.yellow(`You already have a scope: ${existingScope.slug}`),
            );
            console.error();
            console.error("To change your scope, use --force:");
            console.error(chalk.cyan(`  vm0 scope set ${slug} --force`));
            console.error();
            console.error(
              chalk.yellow(
                "Warning: Changing your scope may break existing image references.",
              ),
            );
            process.exit(1);
          }

          scope = await apiClient.updateScope({ slug, force: true });
          console.log(chalk.green(`✓ Scope updated to ${scope.slug}`));
        } else {
          // Create new scope
          scope = await apiClient.createScope({
            slug,
            displayName: options.displayName,
          });
          console.log(chalk.green(`✓ Scope created: ${scope.slug}`));
        }

        console.log();
        console.log("Your images will now be namespaced as:");
        console.log(chalk.cyan(`  ${scope.slug}/<image-name>`));
      } catch (error) {
        if (error instanceof Error) {
          if (error.message.includes("Not authenticated")) {
            console.error(
              chalk.red("✗ Not authenticated. Run: vm0 auth login"),
            );
          } else if (error.message.includes("already exists")) {
            console.error(
              chalk.red(
                `✗ Scope "${slug}" is already taken. Please choose a different slug.`,
              ),
            );
          } else if (error.message.includes("reserved")) {
            console.error(chalk.red(`✗ ${error.message}`));
          } else if (error.message.includes("vm0")) {
            console.error(
              chalk.red(
                "✗ Scope slugs cannot start with 'vm0' (reserved for system use)",
              ),
            );
          } else {
            console.error(chalk.red(`✗ ${error.message}`));
          }
        } else {
          console.error(chalk.red("✗ An unexpected error occurred"));
        }
        process.exit(1);
      }
    },
  );
