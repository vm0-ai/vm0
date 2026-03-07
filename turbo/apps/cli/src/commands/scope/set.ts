import { Command } from "commander";
import chalk from "chalk";
import { getScope, updateScope } from "../../lib/api";

export const setCommand = new Command()
  .name("set")
  .description("Rename your scope slug")
  .argument("<slug>", "The new scope slug")
  .option("--force", "Force change existing scope (may break references)")
  .action(async (slug: string, options: { force?: boolean }) => {
    try {
      const existingScope = await getScope();

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
            "Warning: Changing your scope may break existing agent references.",
          ),
        );
        process.exit(1);
      }

      const scope = await updateScope({ slug, force: true });
      console.log(chalk.green(`✓ Scope updated to ${scope.slug}`));
      console.log();
      console.log("Your agents will now be namespaced as:");
      console.log(chalk.cyan(`  ${scope.slug}/<agent-name>`));
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes("Not authenticated")) {
          console.error(chalk.red("✗ Not authenticated. Run: vm0 auth login"));
        } else if (error.message.includes("already exists")) {
          console.error(
            chalk.red(
              `✗ Scope "${slug}" is already taken. Please choose a different slug.`,
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
  });
