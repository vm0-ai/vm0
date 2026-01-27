import { Command } from "commander";
import chalk from "chalk";
import { deleteModelProvider } from "../../lib/api";
import { MODEL_PROVIDER_TYPES, type ModelProviderType } from "@vm0/core";

export const deleteCommand = new Command()
  .name("delete")
  .description("Delete a model provider")
  .argument("<type>", "Model provider type to delete")
  .action(async (type: string) => {
    try {
      if (!Object.keys(MODEL_PROVIDER_TYPES).includes(type)) {
        console.error(chalk.red(`✗ Invalid type "${type}"`));
        console.log();
        console.log("Valid types:");
        for (const [t, config] of Object.entries(MODEL_PROVIDER_TYPES)) {
          console.log(`  ${chalk.cyan(t)} - ${config.label}`);
        }
        process.exit(1);
      }

      await deleteModelProvider(type as ModelProviderType);
      console.log(chalk.green(`✓ Model provider "${type}" deleted`));
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes("not found")) {
          console.error(chalk.red(`✗ Model provider "${type}" not found`));
        } else if (error.message.includes("Not authenticated")) {
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
