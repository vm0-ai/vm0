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
        throw new Error(`You already have a scope: ${existingScope.slug}`, {
          cause: new Error(
            `To rename your scope, use: vm0 scope set ${slug} --force`,
          ),
        });
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
