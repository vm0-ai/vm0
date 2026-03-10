import { Command } from "commander";
import chalk from "chalk";
import { setModelProviderDefault } from "../../lib/api";
import { withErrorHandler } from "../../lib/command";
import { MODEL_PROVIDER_TYPES, type ModelProviderType } from "@vm0/core";

export const setDefaultCommand = new Command()
  .name("set-default")
  .description("Set a model provider as default for its framework")
  .argument("<type>", "Model provider type to set as default")
  .action(
    withErrorHandler(async (type: string) => {
      if (!Object.keys(MODEL_PROVIDER_TYPES).includes(type)) {
        console.error(chalk.red(`✗ Invalid type "${type}"`));
        console.log();
        console.log("Valid types:");
        for (const [t, config] of Object.entries(MODEL_PROVIDER_TYPES)) {
          console.log(`  ${chalk.cyan(t)} - ${config.label}`);
        }
        process.exit(1);
      }

      const provider = await setModelProviderDefault(type as ModelProviderType);
      console.log(
        chalk.green(
          `✓ Default for ${provider.framework} set to "${provider.type}"`,
        ),
      );
    }),
  );
