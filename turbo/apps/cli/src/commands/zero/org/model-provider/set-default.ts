import { Command } from "commander";
import chalk from "chalk";
import { setZeroOrgModelProviderDefault } from "../../../../lib/api";
import { withErrorHandler } from "../../../../lib/command";
import {
  MODEL_PROVIDER_TYPES,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";

export const setDefaultCommand = new Command()
  .name("set-default")
  .description("Set an org-level model provider as default for its framework")
  .argument("<type>", "Model provider type to set as default")
  .action(
    withErrorHandler(async (type: string) => {
      if (!Object.keys(MODEL_PROVIDER_TYPES).includes(type)) {
        const validTypes = Object.keys(MODEL_PROVIDER_TYPES).join(", ");
        throw new Error(`Invalid type "${type}"`, {
          cause: new Error(`Valid types: ${validTypes}`),
        });
      }

      const provider = await setZeroOrgModelProviderDefault(
        type as ModelProviderType,
      );
      console.log(
        chalk.green(
          `✓ Default for ${provider.framework} set to "${provider.type}"`,
        ),
      );
    }),
  );
