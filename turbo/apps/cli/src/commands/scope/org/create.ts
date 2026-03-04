import { Command } from "commander";
import chalk from "chalk";
import { createOrg, useScope } from "../../../lib/api";
import { setOrgToken } from "../../../lib/api/config";

export const createCommand = new Command()
  .name("create")
  .description("Create a new team scope")
  .argument("<slug>", "Scope slug (e.g., myteam)")
  .action(async (slug: string) => {
    try {
      await createOrg(slug);

      // Auto-switch to the new org scope
      const scopeResult = await useScope(slug);

      if (scopeResult.token) {
        await setOrgToken(
          scopeResult.token,
          scopeResult.expiresAt,
          scopeResult.scope.slug,
        );
      }

      console.log(chalk.green(`✓ Scope '${slug}' created and activated.`));
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red(`✗ ${error.message}`));
      } else {
        console.error(chalk.red("✗ An unexpected error occurred"));
      }
      process.exit(1);
    }
  });
