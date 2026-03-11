import { Command } from "commander";
import chalk from "chalk";
import { deleteModelProvider } from "../../lib/api";
import { withErrorHandler } from "../../lib/command";
import { MODEL_PROVIDER_TYPES, type ModelProviderType } from "@vm0/core";

export const deleteCommand = new Command()
  .name("delete")
  .description("Delete a model provider")
  .argument("<type>", "Model provider type to delete")
  .action(
    withErrorHandler(async (type: string) => {
      if (!Object.keys(MODEL_PROVIDER_TYPES).includes(type)) {
        const validTypes = Object.keys(MODEL_PROVIDER_TYPES).join(", ");
        throw new Error(`Invalid type "${type}"`, {
          cause: new Error(`Valid types: ${validTypes}`),
        });
      }

      await deleteModelProvider(type as ModelProviderType);
      console.log(chalk.green(`✓ Model provider "${type}" deleted`));
    }),
  );
