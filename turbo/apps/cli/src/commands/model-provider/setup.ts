import { Command } from "commander";
import chalk from "chalk";
import prompts from "prompts";
import {
  upsertModelProvider,
  checkModelProviderSecret,
  listModelProviders,
  updateModelProviderModel,
  setModelProviderDefault,
} from "../../lib/api";
import {
  MODEL_PROVIDER_TYPES,
  getModels,
  getDefaultModel,
  hasModelSelection,
  allowsCustomModel,
  getCustomModelPlaceholder,
  hasAuthMethods,
  getAuthMethodsForType,
  getDefaultAuthMethod,
  getSecretsForAuthMethod,
  type ModelProviderType,
} from "@vm0/core";
import { isInteractive } from "../../lib/utils/prompt-utils";

interface SetupInput {
  type: ModelProviderType;
  secret?: string;
  // Multi-auth support
  authMethod?: string;
  secrets?: Record<string, string>;
  selectedModel?: string;
  keepExistingSecret?: boolean;
  isInteractiveMode?: boolean;
}

function validateProviderType(typeStr: string): ModelProviderType {
  if (!Object.keys(MODEL_PROVIDER_TYPES).includes(typeStr)) {
    console.error(chalk.red(`✗ Invalid type "${typeStr}"`));
    console.error();
    console.error("Valid types:");
    for (const [t, config] of Object.entries(MODEL_PROVIDER_TYPES)) {
      console.error(`  ${chalk.cyan(t)} - ${config.label}`);
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

  // Allow any model if provider supports custom models
  if (allowsCustomModel(type)) {
    return modelStr;
  }

  if (models && !models.includes(modelStr)) {
    console.error(chalk.red(`✗ Invalid model "${modelStr}"`));
    console.error();
    console.error("Valid models:");
    for (const m of models) {
      console.error(`  ${chalk.cyan(m)}`);
    }
    process.exit(1);
  }
  return modelStr;
}

function validateAuthMethod(
  type: ModelProviderType,
  authMethodStr: string,
): string | never {
  const authMethods = getAuthMethodsForType(type);
  if (!authMethods || !(authMethodStr in authMethods)) {
    console.error(chalk.red(`✗ Invalid auth method "${authMethodStr}"`));
    console.error();
    console.error("Valid auth methods:");
    if (authMethods) {
      for (const [method, config] of Object.entries(authMethods)) {
        console.error(`  ${chalk.cyan(method)} - ${config.label}`);
      }
    }
    process.exit(1);
  }
  return authMethodStr;
}

/**
 * Parse secret arguments into a secrets object.
 * Supports two formats:
 * - Single value (e.g., "sk-xxx") - auto-mapped to the provider's secret name
 * - KEY=VALUE format (e.g., "AWS_REGION=us-east-1") - explicit mapping
 */
function parseSecrets(
  type: ModelProviderType,
  authMethod: string,
  secretArgs: string[],
): Record<string, string> {
  const secretsConfig = getSecretsForAuthMethod(type, authMethod);
  if (!secretsConfig) {
    console.error(chalk.red(`✗ Invalid auth method "${authMethod}"`));
    process.exit(1);
  }

  const secretNames = Object.keys(secretsConfig);

  // Single value without = sign: only allowed for single-secret auth methods
  const firstArg = secretArgs[0];
  if (secretArgs.length === 1 && firstArg && !firstArg.includes("=")) {
    if (secretNames.length !== 1) {
      console.error(
        chalk.red("✗ Must use KEY=VALUE format for multi-secret auth methods"),
      );
      console.error();
      console.error("Required secrets:");
      for (const [name, fieldConfig] of Object.entries(secretsConfig)) {
        const requiredNote = fieldConfig.required ? " (required)" : "";
        console.error(`  ${chalk.cyan(name)}${requiredNote}`);
      }
      process.exit(1);
    }
    const firstSecretName = secretNames[0];
    if (!firstSecretName) {
      console.error(chalk.red("✗ No secrets defined for this auth method"));
      process.exit(1);
    }
    return { [firstSecretName]: firstArg };
  }

  // KEY=VALUE format
  const secrets: Record<string, string> = {};
  for (const arg of secretArgs) {
    const eqIndex = arg.indexOf("=");
    if (eqIndex === -1) {
      console.error(chalk.red(`✗ Invalid secret format "${arg}"`));
      console.error();
      console.error("Use KEY=VALUE format (e.g., AWS_REGION=us-east-1)");
      process.exit(1);
    }
    const key = arg.slice(0, eqIndex);
    const value = arg.slice(eqIndex + 1);
    secrets[key] = value;
  }
  return secrets;
}

/**
 * Validate secrets against the auth method config.
 */
function validateSecrets(
  type: ModelProviderType,
  authMethod: string,
  secrets: Record<string, string>,
): void {
  const secretsConfig = getSecretsForAuthMethod(type, authMethod);
  if (!secretsConfig) {
    console.error(chalk.red(`✗ Invalid auth method "${authMethod}"`));
    process.exit(1);
  }

  // Check required fields
  for (const [name, fieldConfig] of Object.entries(secretsConfig)) {
    if (fieldConfig.required && !secrets[name]) {
      console.error(chalk.red(`✗ Missing required secret: ${name}`));
      console.error();
      console.error("Required secrets:");
      for (const [n, fc] of Object.entries(secretsConfig)) {
        if (fc.required) {
          console.error(`  ${chalk.cyan(n)} - ${fc.label}`);
        }
      }
      process.exit(1);
    }
  }

  // Check for unknown fields
  for (const name of Object.keys(secrets)) {
    if (!(name in secretsConfig)) {
      console.error(chalk.red(`✗ Unknown secret: ${name}`));
      console.error();
      console.error("Valid secrets:");
      for (const [n, fc] of Object.entries(secretsConfig)) {
        const requiredNote = fc.required ? " (required)" : " (optional)";
        console.error(`  ${chalk.cyan(n)}${requiredNote}`);
      }
      process.exit(1);
    }
  }
}

function handleNonInteractiveMode(options: {
  type: string;
  secret: string[];
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

  // Handle multi-auth providers
  if (hasAuthMethods(type)) {
    // Determine auth method
    let authMethod: string;
    if (options.authMethod) {
      authMethod = validateAuthMethod(type, options.authMethod);
    } else {
      const defaultAuthMethod = getDefaultAuthMethod(type);
      const authMethods = getAuthMethodsForType(type);
      if (!defaultAuthMethod || !authMethods) {
        console.error(chalk.red(`✗ Provider "${type}" requires --auth-method`));
        process.exit(1);
      }
      // If there's only one auth method, use it; otherwise require explicit selection
      const authMethodNames = Object.keys(authMethods);
      if (authMethodNames.length === 1) {
        authMethod = authMethodNames[0]!;
      } else {
        console.error(
          chalk.red(
            `✗ --auth-method is required for "${type}" (multiple auth methods available)`,
          ),
        );
        console.error();
        console.error("Available auth methods:");
        for (const [method, config] of Object.entries(authMethods)) {
          const defaultNote = method === defaultAuthMethod ? " (default)" : "";
          console.error(
            `  ${chalk.cyan(method)} - ${config.label}${defaultNote}`,
          );
        }
        console.error();
        console.error("Example:");
        console.error(
          chalk.cyan(
            `  vm0 model-provider setup --type ${type} --auth-method ${authMethodNames[0]} --secret KEY=VALUE`,
          ),
        );
        process.exit(1);
      }
    }

    // Parse and validate secrets
    const secrets = parseSecrets(type, authMethod, options.secret);
    validateSecrets(type, authMethod, secrets);

    return {
      type,
      authMethod,
      secrets,
      selectedModel,
      isInteractiveMode: false,
    };
  }

  // Single-secret provider (legacy)
  // Accept single value or KEY=VALUE format
  const secretArgs = options.secret;
  const firstArg = secretArgs[0];
  if (!firstArg) {
    console.error(chalk.red("✗ Secret is required"));
    process.exit(1);
  }

  // If KEY=VALUE format, extract the value
  let secret: string;
  if (firstArg.includes("=")) {
    secret = firstArg.slice(firstArg.indexOf("=") + 1);
  } else {
    secret = firstArg;
  }

  return {
    type,
    secret,
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
  const supportsCustomModel = allowsCustomModel(type);

  // Build choices
  const modelChoices: { title: string; value: string }[] = [];

  // Add auto option if defaultModel is empty string
  if (defaultModel === "") {
    modelChoices.push({ title: "auto (Recommended)", value: "" });
  }

  // Add predefined models
  for (const model of models) {
    modelChoices.push({
      title: model === defaultModel ? `${model} (Recommended)` : model,
      value: model,
    });
  }

  // Add custom model option if supported
  if (supportsCustomModel) {
    modelChoices.push({ title: "Custom model ID", value: "__custom__" });
  }

  const modelResponse = await prompts(
    {
      type: "select",
      name: "model",
      message: "Select model:",
      choices: modelChoices,
    },
    { onCancel: () => process.exit(0) },
  );

  const selected = modelResponse.model as string;

  // Handle custom model input
  if (selected === "__custom__") {
    const placeholder = getCustomModelPlaceholder(type);
    if (placeholder) {
      console.log(chalk.dim(`Example: ${placeholder}`));
    }
    const customResponse = await prompts(
      {
        type: "text",
        name: "customModel",
        message: "Enter model ID:",
        validate: (value: string) => value.length > 0 || "Model ID is required",
      },
      { onCancel: () => process.exit(0) },
    );
    return customResponse.customModel as string;
  }

  // Return undefined for auto mode (empty string)
  return selected === "" ? undefined : selected;
}

/**
 * Prompt for auth method selection (only for multi-auth providers)
 */
async function promptForAuthMethod(type: ModelProviderType): Promise<string> {
  const authMethods = getAuthMethodsForType(type);
  const defaultAuthMethod = getDefaultAuthMethod(type);

  if (!authMethods) {
    return "default";
  }

  const choices = Object.entries(authMethods).map(([method, config]) => ({
    title:
      method === defaultAuthMethod
        ? `${config.label} (Recommended)`
        : config.label,
    value: method,
  }));

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
/**
 * Determine if a secret should be masked (password type)
 * Non-secret values like region should be visible
 */
function isSensitiveSecret(name: string): boolean {
  const nonSecretPatterns = ["REGION", "ENDPOINT", "URL"];
  return !nonSecretPatterns.some((pattern) =>
    name.toUpperCase().includes(pattern),
  );
}

async function promptForSecrets(
  type: ModelProviderType,
  authMethod: string,
): Promise<Record<string, string>> {
  const secretsConfig = getSecretsForAuthMethod(type, authMethod);

  if (!secretsConfig) {
    console.error(chalk.red(`✗ Invalid auth method "${authMethod}"`));
    process.exit(1);
  }

  const secrets: Record<string, string> = {};

  for (const [name, fieldConfig] of Object.entries(secretsConfig)) {
    if (fieldConfig.helpText) {
      console.log(chalk.dim(fieldConfig.helpText));
    }

    const isSensitive = isSensitiveSecret(name);
    const placeholder =
      "placeholder" in fieldConfig ? (fieldConfig.placeholder as string) : "";

    if (fieldConfig.required) {
      const response = await prompts(
        {
          type: isSensitive ? "password" : "text",
          name: "value",
          message: `${fieldConfig.label}:`,
          initial: placeholder ? "" : undefined,
          validate: (value: string) =>
            value.length > 0 || `${fieldConfig.label} is required`,
        },
        { onCancel: () => process.exit(0) },
      );
      secrets[name] = response.value as string;
    } else {
      // Optional field
      const response = await prompts(
        {
          type: isSensitive ? "password" : "text",
          name: "value",
          message: `${fieldConfig.label} (optional):`,
        },
        { onCancel: () => process.exit(0) },
      );
      const value = response.value as string;
      if (value && value.trim()) {
        secrets[name] = value.trim();
      }
    }
  }

  return secrets;
}

async function handleInteractiveMode(): Promise<SetupInput | null> {
  if (!isInteractive()) {
    console.error(chalk.red("✗ Interactive mode requires a TTY"));
    console.error();
    console.error("Use non-interactive mode:");
    console.error(
      chalk.cyan('  vm0 model-provider setup --type <type> --secret "<value>"'),
    );
    process.exit(1);
  }

  // Fetch configured providers to annotate choices
  const { modelProviders: configuredProviders } = await listModelProviders();
  const configuredTypes = new Set(configuredProviders.map((p) => p.type));

  // Build provider choices with configuration status
  const annotatedChoices = Object.entries(MODEL_PROVIDER_TYPES).map(
    ([type, config]) => {
      const isConfigured = configuredTypes.has(type as ModelProviderType);
      const isExperimental = hasAuthMethods(type as ModelProviderType);
      let title: string = config.label;
      if (isConfigured) {
        title = `${title} ✓`;
      }
      if (isExperimental) {
        title = `${title} ${chalk.dim("(experimental)")}`;
      }
      return {
        title,
        value: type as ModelProviderType,
      };
    },
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

  // Check if secret already exists
  const checkResult = await checkModelProviderSecret(type);

  // Handle existing model-provider secret
  if (checkResult.exists) {
    console.log();
    console.log(`"${type}" is already configured`);
    console.log();

    const actionResponse = await prompts(
      {
        type: "select",
        name: "action",
        message: "",
        choices: [
          { title: "Keep existing secret", value: "keep" },
          { title: "Update secret", value: "update" },
        ],
      },
      { onCancel: () => process.exit(0) },
    );

    if (actionResponse.action === "keep") {
      // Keep existing secret - only prompt for model if applicable
      const selectedModel = await promptForModelSelection(type);
      return {
        type,
        keepExistingSecret: true,
        selectedModel,
        isInteractiveMode: true,
      };
    }
    // Fall through to secret prompt for "update"
  }

  const config = MODEL_PROVIDER_TYPES[type];

  console.log();
  console.log(chalk.dim(config.helpText));
  console.log();

  // Handle multi-auth providers
  if (hasAuthMethods(type)) {
    const authMethod = await promptForAuthMethod(type);
    const secrets = await promptForSecrets(type, authMethod);
    const selectedModel = await promptForModelSelection(type);

    return {
      type,
      authMethod,
      secrets,
      selectedModel,
      isInteractiveMode: true,
    };
  }

  // Single-secret provider (legacy)
  const secretLabel = "secretLabel" in config ? config.secretLabel : "secret";

  const secretResponse = await prompts(
    {
      type: "password",
      name: "secret",
      message: `Enter your ${secretLabel}:`,
      validate: (value: string) =>
        value.length > 0 || `${secretLabel} is required`,
    },
    { onCancel: () => process.exit(0) },
  );

  const secret = secretResponse.secret as string;
  const selectedModel = await promptForModelSelection(type);

  return { type, secret, selectedModel, isInteractiveMode: true };
}

function handleSetupError(error: unknown): never {
  if (error instanceof Error) {
    if (error.message.includes("Not authenticated")) {
      console.error(chalk.red("✗ Not authenticated"));
      console.error(chalk.dim("  Run: vm0 auth login"));
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
 * Collect secret values from repeatable --secret option
 */
function collectSecrets(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

export const setupCommand = new Command()
  .name("setup")
  .description("Configure a model provider")
  .option("-t, --type <type>", "Provider type (for non-interactive mode)")
  .option(
    "-s, --secret <value>",
    "Secret value (can be used multiple times, supports VALUE or KEY=VALUE format)",
    collectSecrets,
    [],
  )
  .option(
    "-a, --auth-method <method>",
    "Auth method (required for multi-auth providers like aws-bedrock)",
  )
  .option("-m, --model <model>", "Model selection (for non-interactive mode)")
  .action(
    async (options: {
      type?: string;
      secret?: string[];
      authMethod?: string;
      model?: string;
    }) => {
      try {
        let input: SetupInput;
        const secretArgs = options.secret ?? [];

        if (options.type && secretArgs.length > 0) {
          input = handleNonInteractiveMode({
            type: options.type,
            secret: secretArgs,
            authMethod: options.authMethod,
            model: options.model,
          });
        } else if (options.type || secretArgs.length > 0) {
          console.error(chalk.red("✗ Both --type and --secret are required"));
          process.exit(1);
        } else {
          const result = await handleInteractiveMode();
          if (result === null) {
            return; // Conversion was done
          }
          input = result;
        }

        // Handle "keep existing secret" flow
        if (input.keepExistingSecret) {
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

        // Standard upsert flow with secret
        const { provider, created } = await upsertModelProvider({
          type: input.type,
          secret: input.secret,
          authMethod: input.authMethod,
          secrets: input.secrets,
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
