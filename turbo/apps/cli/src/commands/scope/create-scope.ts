import { Command } from "commander";
import chalk from "chalk";
import { createScope, getScope, ApiRequestError } from "../../lib/api";
import { saveConfig } from "../../lib/api/config";
import { withErrorHandler } from "../../lib/command";

export const createCommand = new Command()
  .name("create")
  .description("Create a new scope")
  .argument("<slug>", "Scope slug (e.g., myteam)")
  .action(
    withErrorHandler(async (slug: string) => {
      // Check if user already has a scope
      try {
        const existingScope = await getScope();
        console.error(
          chalk.yellow(`✗ You already have a scope: ${existingScope.slug}`),
        );
        console.error();
        console.error("To rename your scope, use:");
        console.error(chalk.cyan(`  vm0 scope set ${slug} --force`));
        process.exit(1);
      } catch (error) {
        // 404 means user has no scope — proceed with creation
        if (!(error instanceof ApiRequestError) || error.status !== 404) {
          throw error;
        }
      }

      const scope = await createScope({ slug });

      // Auto-switch to the new scope
      await saveConfig({ activeScope: scope.slug });

      console.log(
        chalk.green(`✓ Scope '${scope.slug}' created and activated.`),
      );
      console.log();
      console.log("Your agents will now be namespaced as:");
      console.log(chalk.cyan(`  ${scope.slug}/<agent-name>`));
    }),
  );
