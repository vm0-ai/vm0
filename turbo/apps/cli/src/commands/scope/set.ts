import { Command } from "commander";
import chalk from "chalk";
import { getScope, updateScope } from "../../lib/api";
import { withErrorHandler } from "../../lib/command";

export const setCommand = new Command()
  .name("set")
  .description("Rename your scope slug")
  .argument("<slug>", "The new scope slug")
  .option("--force", "Force change existing scope (may break references)")
  .action(
    withErrorHandler(async (slug: string, options: { force?: boolean }) => {
      try {
        const existingScope = await getScope();

        if (!options.force) {
          throw new Error(`You already have a scope: ${existingScope.slug}`, {
            cause: new Error(`To change, use: vm0 scope set ${slug} --force`),
          });
        }

        const scope = await updateScope({ slug, force: true });
        console.log(chalk.green(`✓ Scope updated to ${scope.slug}`));
        console.log();
        console.log("Your agents will now be namespaced as:");
        console.log(chalk.cyan(`  ${scope.slug}/<agent-name>`));
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("already exists")
        ) {
          throw new Error(
            `Scope "${slug}" is already taken. Please choose a different slug.`,
          );
        }
        throw error;
      }
    }),
  );
