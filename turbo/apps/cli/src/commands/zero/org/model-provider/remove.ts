import { Command } from "commander";
import chalk from "chalk";
import { deleteZeroOrgModelProvider } from "../../../../lib/api";
import { withErrorHandler } from "../../../../lib/command";
import {
  MODEL_PROVIDER_TYPES,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";

interface CreateRemoveCommandOptions {
  scopeLabel?: string;
}

export function createRemoveCommand(
  options: CreateRemoveCommandOptions = {},
): Command {
  const scopeLabel = options.scopeLabel ?? "Org";

  return new Command()
    .name("remove")
    .description(`Remove a ${scopeLabel.toLowerCase()} model provider`)
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
        console.log(
          chalk.green(`✓ ${scopeLabel} model provider "${type}" removed`),
        );
      }),
    );
}

export const removeCommand = createRemoveCommand();
