import { Command } from "commander";
import chalk from "chalk";
import { createScope } from "../../lib/api";
import { saveConfig } from "../../lib/api/config";

export const createCommand = new Command()
  .name("create")
  .description("Create a new team scope")
  .argument("<slug>", "Scope slug (e.g., myteam)")
  .action(async (slug: string) => {
    try {
      await createScope({ slug });

      // Auto-switch to the new org scope
      await saveConfig({ activeScope: slug });

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
