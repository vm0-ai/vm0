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
  getNormalizedAuthConfig,
  requiresAuthMethodSelection,
  type ModelProviderType,
} from "@vm0/core";
import { isInteractive } from "../../lib/utils/prompt-utils";

interface SetupInput {
  type: ModelProviderType;
  credential?: string;
  // Multi-auth support
  authMethod?: string;
  credentials?: Record<string, string>;
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

function validateAuthMethod(
  type: ModelProviderType,
  authMethodStr: string,
): string | never {
  const normalized = getNormalizedAuthConfig(type);
  if (!(authMethodStr in normalized.authMethods)) {
    console.error(chalk.red(`✗ Invalid auth method "${authMethodStr}"`));
    console.log();
    console.log("Valid auth methods:");
    for (const [method, config] of Object.entries(normalized.authMethods)) {
      console.log(`  ${chalk.cyan(method)} - ${config.label}`);
    }
    process.exit(1);
  }
  return authMethodStr;
}

/**
 * Parse credential arguments into a credentials object.
 * Supports two formats:
 * - Single value (e.g., "sk-xxx") - auto-mapped to the provider's credential name
 * - KEY=VALUE format (e.g., "AWS_REGION=us-east-1") - explicit mapping
 */
function parseCredentials(
  type: ModelProviderType,
  authMethod: string,
  credentialArgs: string[],
): Record<string, string> {
  const normalized = getNormalizedAuthConfig(type);
  const methodConfig = normalized.authMethods[authMethod];

  if (!methodConfig) {
    console.error(chalk.red(`✗ Invalid auth method "${authMethod}"`));
    process.exit(1);
  }

  const credentialNames = Object.keys(methodConfig.credentials);

  // Single value without = sign: map to the unique credential name
  const firstArg = credentialArgs[0];
  if (credentialArgs.length === 1 && firstArg && !firstArg.includes("=")) {
    if (credentialNames.length !== 1) {
      console.error(
        chalk.red("✗ Must use KEY=VALUE format for multi-credential providers"),
      );
      console.log();
      console.log("Required credentials:");
      for (const [name, fieldConfig] of Object.entries(
        methodConfig.credentials,
      )) {
        const requiredNote = fieldConfig.required ? " (required)" : "";
        console.log(`  ${chalk.cyan(name)}${requiredNote}`);
      }
      process.exit(1);
    }
    const firstCredentialName = credentialNames[0];
    if (!firstCredentialName) {
      console.error(chalk.red("✗ No credentials defined for this auth method"));
      process.exit(1);
    }
    return { [firstCredentialName]: firstArg };
  }

  // KEY=VALUE format
  const credentials: Record<string, string> = {};
  for (const arg of credentialArgs) {
    const eqIndex = arg.indexOf("=");
    if (eqIndex === -1) {
      console.error(chalk.red(`✗ Invalid credential format "${arg}"`));
      console.log();
      console.log("Use KEY=VALUE format (e.g., API_KEY=xxx)");
      process.exit(1);
    }
    const key = arg.slice(0, eqIndex);
    const value = arg.slice(eqIndex + 1);
    credentials[key] = value;
  }
  return credentials;
}

/**
 * Validate credentials against the auth method config.
 * Ensures required fields are present and no unknown fields exist.
 */
function validateCredentials(
  type: ModelProviderType,
  authMethod: string,
  credentials: Record<string, string>,
): void {
  const normalized = getNormalizedAuthConfig(type);
  const methodConfig = normalized.authMethods[authMethod];

  if (!methodConfig) {
    console.error(chalk.red(`✗ Invalid auth method "${authMethod}"`));
    process.exit(1);
  }

  // Check required fields
  for (const [name, fieldConfig] of Object.entries(methodConfig.credentials)) {
    if (fieldConfig.required && !credentials[name]) {
      console.error(chalk.red(`✗ Missing required credential: ${name}`));
      console.log();
      console.log("Required credentials:");
      for (const [n, fc] of Object.entries(methodConfig.credentials)) {
        if (fc.required) {
          console.log(`  ${chalk.cyan(n)} - ${fc.label}`);
        }
      }
      process.exit(1);
    }
  }

  // Check for unknown fields
  for (const name of Object.keys(credentials)) {
    if (!(name in methodConfig.credentials)) {
      console.error(chalk.red(`✗ Unknown credential: ${name}`));
      console.log();
      console.log("Valid credentials:");
      for (const [n, fc] of Object.entries(methodConfig.credentials)) {
        const requiredNote = fc.required ? " (required)" : " (optional)";
        console.log(`  ${chalk.cyan(n)}${requiredNote}`);
      }
      process.exit(1);
    }
  }
}

function handleNonInteractiveMode(options: {
  type: string;
  credential: string[];
  authMethod?: string;
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

  // Determine auth method
  let authMethod: string;
  if (options.authMethod) {
    authMethod = validateAuthMethod(type, options.authMethod);
  } else if (requiresAuthMethodSelection(type)) {
    // Multi-auth provider without --auth-method specified
    const normalized = getNormalizedAuthConfig(type);
    const methods = Object.keys(normalized.authMethods);
    console.error(
      chalk.red(
        `✗ --auth-method is required for "${type}" (multiple auth methods available)`,
      ),
    );
    console.log();
    console.log("Available auth methods:");
    for (const [method, config] of Object.entries(normalized.authMethods)) {
      const defaultNote =
        method === normalized.defaultAuthMethod ? " (default)" : "";
      console.log(`  ${chalk.cyan(method)} - ${config.label}${defaultNote}`);
    }
    console.log();
    console.log("Example:");
    console.log(
      chalk.cyan(
        `  vm0 model-provider setup --type ${type} --auth-method ${methods[0]} --credential KEY=VALUE`,
      ),
    );
    process.exit(1);
  } else {
    // Single-auth provider - use "default"
    authMethod = "default";
  }

  // Parse and validate credentials
  const credentials = parseCredentials(type, authMethod, options.credential);
  validateCredentials(type, authMethod, credentials);

  // For backward compatibility with single-credential providers,
  // extract the single credential value
  const credentialValues = Object.values(credentials);
  const singleCredential =
    credentialValues.length === 1 ? credentialValues[0] : undefined;

  return {
    type,
    credential: singleCredential,
    authMethod: authMethod !== "default" ? authMethod : undefined,
    credentials: authMethod !== "default" ? credentials : undefined,
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

/**
 * Prompt for auth method selection (only for multi-auth providers)
 */
async function promptForAuthMethod(type: ModelProviderType): Promise<string> {
  if (!requiresAuthMethodSelection(type)) {
    return "default";
  }

  const normalized = getNormalizedAuthConfig(type);
  const choices = Object.entries(normalized.authMethods).map(
    ([method, config]) => ({
      title:
        method === normalized.defaultAuthMethod
          ? `${config.label} (Recommended)`
          : config.label,
      value: method,
    }),
  );

  const response = await prompts(
    {
      type: "select",
      name: "authMethod",
      message: "Select authentication method:",
      choices,
    },
    { onCancel: () => process.exit(0) },
  );

  return response.authMethod as string;
}

/**
 * Prompt for credentials based on auth method configuration
 */
async function promptForCredentials(
  type: ModelProviderType,
  authMethod: string,
): Promise<Record<string, string>> {
  const normalized = getNormalizedAuthConfig(type);
  const methodConfig = normalized.authMethods[authMethod];

  if (!methodConfig) {
    console.error(chalk.red(`✗ Invalid auth method "${authMethod}"`));
    process.exit(1);
  }

  const credentials: Record<string, string> = {};

  for (const [name, fieldConfig] of Object.entries(methodConfig.credentials)) {
    if (fieldConfig.required) {
      const response = await prompts(
        {
          type: "password",
          name: "value",
          message: `Enter ${fieldConfig.label}:`,
          validate: (value: string) =>
            value.length > 0 || `${fieldConfig.label} is required`,
        },
        { onCancel: () => process.exit(0) },
      );
      credentials[name] = response.value as string;
    } else {
      // Optional field - prompt with ability to skip
      const response = await prompts(
        {
          type: "text",
          name: "value",
          message: `Enter ${fieldConfig.label} (optional, press Enter to skip):`,
        },
        { onCancel: () => process.exit(0) },
      );
      const value = response.value as string;
      if (value && value.trim()) {
        credentials[name] = value.trim();
      }
    }
  }

  return credentials;
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

  // Select auth method for multi-auth providers
  const authMethod = await promptForAuthMethod(type);

  // Collect credentials based on auth method
  const credentials = await promptForCredentials(type, authMethod);
  const selectedModel = await promptForModelSelection(type);

  // For single-credential providers, extract the credential value
  const credentialValues = Object.values(credentials);
  const singleCredential =
    credentialValues.length === 1 ? credentialValues[0] : undefined;

  return {
    type,
    credential: singleCredential,
    authMethod: authMethod !== "default" ? authMethod : undefined,
    credentials: authMethod !== "default" ? credentials : undefined,
    selectedModel,
    isInteractiveMode: true,
  };
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

/**
 * Collect credential values from repeatable --credential option
 */
function collectCredentials(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

export const setupCommand = new Command()
  .name("setup")
  .description("Configure a model provider")
  .option("-t, --type <type>", "Provider type (for non-interactive mode)")
  .option(
    "-c, --credential <value>",
    "Credential value (can be used multiple times, supports VALUE or KEY=VALUE format)",
    collectCredentials,
    [],
  )
  .option(
    "-a, --auth-method <method>",
    "Auth method (required for multi-auth providers)",
  )
  .option("-m, --model <model>", "Model selection (for non-interactive mode)")
  .option("--convert", "Convert existing user credential to model provider")
  .action(
    async (options: {
      type?: string;
      credential?: string[];
      authMethod?: string;
      model?: string;
      convert?: boolean;
    }) => {
      try {
        let input: SetupInput;
        const shouldConvert = options.convert ?? false;
        const credentialArgs = options.credential ?? [];

        if (options.type && credentialArgs.length > 0) {
          input = handleNonInteractiveMode({
            type: options.type,
            credential: credentialArgs,
            authMethod: options.authMethod,
            model: options.model,
          });
        } else if (options.type || credentialArgs.length > 0) {
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
          credential: input.credential,
          authMethod: input.authMethod,
          credentials: input.credentials,
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
