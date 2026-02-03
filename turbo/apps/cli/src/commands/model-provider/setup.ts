import { Command } from "commander";
import chalk from "chalk";
import prompts from "prompts";
import {
  upsertModelProvider,
  checkModelProviderCredential,
  convertModelProviderCredential,
  listModelProviders,
  updateModelProviderModel,
  setModelProviderDefault,
} from "../../lib/api";
import {
  MODEL_PROVIDER_TYPES,
  getModels,
  getDefaultModel,
  hasModelSelection,
  type ModelProviderType,
} from "@vm0/core";
import { isInteractive } from "../../lib/utils/prompt-utils";

interface SetupInput {
  type: ModelProviderType;
  credential?: string;
  selectedModel?: string;
  keepExistingCredential?: boolean;
  isInteractiveMode?: boolean;
}

function validateProviderType(typeStr: string): ModelProviderType {
  if (!Object.keys(MODEL_PROVIDER_TYPES).includes(typeStr)) {
    console.error(chalk.red(`✗ Invalid type "${typeStr}"`));
    console.log();
    console.log("Valid types:");
    for (const [t, config] of Object.entries(MODEL_PROVIDER_TYPES)) {
      console.log(`  ${chalk.cyan(t)} - ${config.label}`);
    }
    process.exit(1);
  }
  return typeStr as ModelProviderType;
}

function validateModel(
  type: ModelProviderType,
  modelStr: string,
): string | never {
  const models = getModels(type);
  if (models && !models.includes(modelStr)) {
    console.error(chalk.red(`✗ Invalid model "${modelStr}"`));
    console.log();
    console.log("Valid models:");
    for (const m of models) {
      console.log(`  ${chalk.cyan(m)}`);
    }
    process.exit(1);
  }
  return modelStr;
}

function handleNonInteractiveMode(options: {
  type: string;
  credential: string;
  model?: string;
}): SetupInput {
  const type = validateProviderType(options.type);
  let selectedModel: string | undefined;

  if (options.model) {
    selectedModel = validateModel(type, options.model);
  } else if (hasModelSelection(type)) {
    const defaultModel = getDefaultModel(type);
    // Empty defaultModel means "auto" mode - don't set selectedModel
    selectedModel = defaultModel || undefined;
  }

  return {
    type,
    credential: options.credential,
    selectedModel,
    isInteractiveMode: false,
  };
}

async function promptForModelSelection(
  type: ModelProviderType,
): Promise<string | undefined> {
  if (!hasModelSelection(type)) {
    return undefined;
  }

  const models = getModels(type) ?? [];
  const defaultModel = getDefaultModel(type);

  // Build choices - add "auto" option if defaultModel is empty
  const modelChoices =
    defaultModel === ""
      ? [
          { title: "auto (Recommended)", value: "" },
          ...models.map((model) => ({ title: model, value: model })),
        ]
      : models.map((model) => ({
          title: model === defaultModel ? `${model} (Recommended)` : model,
          value: model,
        }));

  const modelResponse = await prompts(
    {
      type: "select",
      name: "model",
      message: "Select model:",
      choices: modelChoices,
    },
    { onCancel: () => process.exit(0) },
  );

  // Return undefined for auto mode (empty string)
  const selected = modelResponse.model as string;
  return selected === "" ? undefined : selected;
}

async function handleInteractiveMode(): Promise<SetupInput | null> {
  if (!isInteractive()) {
    console.error(chalk.red("✗ Interactive mode requires a TTY"));
    console.log();
    console.log("Use non-interactive mode:");
    console.log(
      chalk.cyan(
        '  vm0 model-provider setup --type <type> --credential "<value>"',
      ),
    );
    process.exit(1);
  }

  // Fetch configured providers to annotate choices
  const { modelProviders: configuredProviders } = await listModelProviders();
  const configuredTypes = new Set(configuredProviders.map((p) => p.type));

  // Build provider choices with configuration status
  const annotatedChoices = Object.entries(MODEL_PROVIDER_TYPES).map(
    ([type, config]) => ({
      title: configuredTypes.has(type as ModelProviderType)
        ? `${config.label} ✓`
        : config.label,
      value: type as ModelProviderType,
    }),
  );

  const typeResponse = await prompts(
    {
      type: "select",
      name: "type",
      message: "Select provider type:",
      choices: annotatedChoices,
    },
    { onCancel: () => process.exit(0) },
  );

  const type = typeResponse.type as ModelProviderType;

  // Check if credential already exists
  const checkResult = await checkModelProviderCredential(type);

  // Handle user credential conversion
  if (checkResult.exists && checkResult.currentType === "user") {
    const convertResponse = await prompts(
      {
        type: "confirm",
        name: "convert",
        message: `Credential "${checkResult.credentialName}" already exists. Convert to model provider?`,
        initial: true,
      },
      { onCancel: () => process.exit(0) },
    );

    if (convertResponse.convert) {
      const provider = await convertModelProviderCredential(type);
      const defaultNote = provider.isDefault
        ? ` (default for ${provider.framework})`
        : "";
      console.log(
        chalk.green(
          `✓ Converted "${checkResult.credentialName}" to model provider${defaultNote}`,
        ),
      );
      await promptSetAsDefault(type, provider.framework, provider.isDefault);
      return null; // Signal that conversion was done
    }
    console.log(chalk.dim("Aborted"));
    process.exit(0);
  }

  // Handle existing model-provider credential
  if (checkResult.exists && checkResult.currentType === "model-provider") {
    console.log();
    console.log(`"${type}" is already configured.`);
    console.log();

    const actionResponse = await prompts(
      {
        type: "select",
        name: "action",
        message: "",
        choices: [
          { title: "Keep existing credential", value: "keep" },
          { title: "Update credential", value: "update" },
        ],
      },
      { onCancel: () => process.exit(0) },
    );

    if (actionResponse.action === "keep") {
      // Keep existing credential - only prompt for model if applicable
      const selectedModel = await promptForModelSelection(type);
      return {
        type,
        keepExistingCredential: true,
        selectedModel,
        isInteractiveMode: true,
      };
    }
    // Fall through to credential prompt for "update"
  }

  const config = MODEL_PROVIDER_TYPES[type];

  console.log();
  console.log(chalk.dim(config.helpText));
  console.log();

  const credentialResponse = await prompts(
    {
      type: "password",
      name: "credential",
      message: `Enter your ${config.credentialLabel}:`,
      validate: (value: string) =>
        value.length > 0 || `${config.credentialLabel} is required`,
    },
    { onCancel: () => process.exit(0) },
  );

  const credential = credentialResponse.credential as string;
  const selectedModel = await promptForModelSelection(type);

  return { type, credential, selectedModel, isInteractiveMode: true };
}

function handleSetupError(error: unknown): never {
  if (error instanceof Error) {
    if (error.message.includes("already exists")) {
      console.error(chalk.red(`✗ ${error.message}`));
      console.log();
      console.log("To convert the existing credential, run:");
      console.log(chalk.cyan("  vm0 model-provider setup --convert"));
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

async function promptSetAsDefault(
  type: ModelProviderType,
  framework: string,
  isDefault: boolean,
): Promise<void> {
  if (isDefault) return;

  const response = await prompts(
    {
      type: "confirm",
      name: "setDefault",
      message: "Set this provider as default?",
      initial: false,
    },
    { onCancel: () => process.exit(0) },
  );

  if (response.setDefault) {
    await setModelProviderDefault(type);
    console.log(chalk.green(`✓ Default for ${framework} set to "${type}"`));
  }
}

export const setupCommand = new Command()
  .name("setup")
  .description("Configure a model provider")
  .option("-t, --type <type>", "Provider type (for non-interactive mode)")
  .option(
    "-c, --credential <credential>",
    "Credential value (for non-interactive mode)",
  )
  .option("-m, --model <model>", "Model selection (for non-interactive mode)")
  .option("--convert", "Convert existing user credential to model provider")
  .action(
    async (options: {
      type?: string;
      credential?: string;
      model?: string;
      convert?: boolean;
    }) => {
      try {
        let input: SetupInput;
        const shouldConvert = options.convert ?? false;

        if (options.type && options.credential) {
          input = handleNonInteractiveMode({
            type: options.type,
            credential: options.credential,
            model: options.model,
          });
        } else if (options.type || options.credential) {
          console.error(
            chalk.red("✗ Both --type and --credential are required"),
          );
          process.exit(1);
        } else {
          const result = await handleInteractiveMode();
          if (result === null) {
            return; // Conversion was done
          }
          input = result;
        }

        // Handle "keep existing credential" flow
        if (input.keepExistingCredential) {
          const provider = await updateModelProviderModel(
            input.type,
            input.selectedModel,
          );

          const defaultNote = provider.isDefault
            ? ` (default for ${provider.framework})`
            : "";
          const modelNote = provider.selectedModel
            ? ` with model: ${provider.selectedModel}`
            : "";

          // If no model selection, show "unchanged" message
          if (!hasModelSelection(input.type)) {
            console.log(
              chalk.green(`✓ Model provider "${input.type}" unchanged`),
            );
          } else {
            console.log(
              chalk.green(
                `✓ Model provider "${input.type}" updated${defaultNote}${modelNote}`,
              ),
            );
          }
          if (input.isInteractiveMode) {
            await promptSetAsDefault(
              input.type,
              provider.framework,
              provider.isDefault,
            );
          }
          return;
        }

        // Standard upsert flow with credential
        const { provider, created } = await upsertModelProvider({
          type: input.type,
          credential: input.credential!,
          convert: shouldConvert,
          selectedModel: input.selectedModel,
        });

        const action = created ? "created" : "updated";
        const defaultNote = provider.isDefault
          ? ` (default for ${provider.framework})`
          : "";
        const modelNote = provider.selectedModel
          ? ` with model: ${provider.selectedModel}`
          : "";
        console.log(
          chalk.green(
            `✓ Model provider "${input.type}" ${action}${defaultNote}${modelNote}`,
          ),
        );
        if (input.isInteractiveMode) {
          await promptSetAsDefault(
            input.type,
            provider.framework,
            provider.isDefault,
          );
        }
      } catch (error) {
        handleSetupError(error);
      }
    },
  );
