import { Command } from "commander";
import chalk from "chalk";
import { deleteZeroOrgModelProvider } from "../../../../lib/api";
import { withErrorHandler } from "../../../../lib/command";
import {
  MODEL_PROVIDER_TYPES,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";

export const removeCommand = new Command()
  .name("remove")
  .description("Remove an org-level model provider")
  .argument("<type>", "Model provider type to remove")
  .action(
    withErrorHandler(async (type: string) => {
      if (!Object.keys(MODEL_PROVIDER_TYPES).includes(type)) {
        const validTypes = Object.keys(MODEL_PROVIDER_TYPES).join(", ");
        throw new Error(`Invalid type "${type}"`, {
          cause: new Error(`Valid types: ${validTypes}`),
        });
      }

      await deleteZeroOrgModelProvider(type as ModelProviderType);
      console.log(chalk.green(`✓ Org model provider "${type}" removed`));
    }),
  );
