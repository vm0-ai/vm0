import { Command } from "commander";
import chalk from "chalk";
import prompts from "prompts";
import {
  upsertModelProvider,
  checkModelProviderCredential,
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
  getCredentialsForAuthMethod,
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

  // Allow any model if provider supports custom models
  if (allowsCustomModel(type)) {
    return modelStr;
  }

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
  const authMethods = getAuthMethodsForType(type);
  if (!authMethods || !(authMethodStr in authMethods)) {
    console.error(chalk.red(`✗ Invalid auth method "${authMethodStr}"`));
    console.log();
    console.log("Valid auth methods:");
    if (authMethods) {
      for (const [method, config] of Object.entries(authMethods)) {
        console.log(`  ${chalk.cyan(method)} - ${config.label}`);
      }
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
  const credentialsConfig = getCredentialsForAuthMethod(type, authMethod);
  if (!credentialsConfig) {
    console.error(chalk.red(`✗ Invalid auth method "${authMethod}"`));
    process.exit(1);
  }

  const credentialNames = Object.keys(credentialsConfig);

  // Single value without = sign: only allowed for single-credential auth methods
  const firstArg = credentialArgs[0];
  if (credentialArgs.length === 1 && firstArg && !firstArg.includes("=")) {
    if (credentialNames.length !== 1) {
      console.error(
        chalk.red(
          "✗ Must use KEY=VALUE format for multi-credential auth methods",
        ),
      );
      console.log();
      console.log("Required credentials:");
      for (const [name, fieldConfig] of Object.entries(credentialsConfig)) {
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
      console.log("Use KEY=VALUE format (e.g., AWS_REGION=us-east-1)");
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
 */
function validateCredentials(
  type: ModelProviderType,
  authMethod: string,
  credentials: Record<string, string>,
): void {
  const credentialsConfig = getCredentialsForAuthMethod(type, authMethod);
  if (!credentialsConfig) {
    console.error(chalk.red(`✗ Invalid auth method "${authMethod}"`));
    process.exit(1);
  }

  // Check required fields
  for (const [name, fieldConfig] of Object.entries(credentialsConfig)) {
    if (fieldConfig.required && !credentials[name]) {
      console.error(chalk.red(`✗ Missing required credential: ${name}`));
      console.log();
      console.log("Required credentials:");
      for (const [n, fc] of Object.entries(credentialsConfig)) {
        if (fc.required) {
          console.log(`  ${chalk.cyan(n)} - ${fc.label}`);
        }
      }
      process.exit(1);
    }
  }

  // Check for unknown fields
  for (const name of Object.keys(credentials)) {
    if (!(name in credentialsConfig)) {
      console.error(chalk.red(`✗ Unknown credential: ${name}`));
      console.log();
      console.log("Valid credentials:");
      for (const [n, fc] of Object.entries(credentialsConfig)) {
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
        console.log();
        console.log("Available auth methods:");
        for (const [method, config] of Object.entries(authMethods)) {
          const defaultNote = method === defaultAuthMethod ? " (default)" : "";
          console.log(
            `  ${chalk.cyan(method)} - ${config.label}${defaultNote}`,
          );
        }
        console.log();
        console.log("Example:");
        console.log(
          chalk.cyan(
            `  vm0 model-provider setup --type ${type} --auth-method ${authMethodNames[0]} --credential KEY=VALUE`,
          ),
        );
        process.exit(1);
      }
    }

    // Parse and validate credentials
    const credentials = parseCredentials(type, authMethod, options.credential);
    validateCredentials(type, authMethod, credentials);

    return {
      type,
      authMethod,
      credentials,
      selectedModel,
      isInteractiveMode: false,
    };
  }

  // Single-credential provider (legacy)
  // Accept single value or KEY=VALUE format
  const credentialArgs = options.credential;
  const firstArg = credentialArgs[0];
  if (!firstArg) {
    console.error(chalk.red("✗ Credential is required"));
    process.exit(1);
  }

  // If KEY=VALUE format, extract the value
  let credential: string;
  if (firstArg.includes("=")) {
    credential = firstArg.slice(firstArg.indexOf("=") + 1);
  } else {
    credential = firstArg;
  }

  return {
    type,
    credential,
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
 * Determine if a credential should be masked (password type)
 * Non-secret values like region should be visible
 */
function isSecretCredential(name: string): boolean {
  const nonSecretPatterns = ["REGION", "ENDPOINT", "URL"];
  return !nonSecretPatterns.some((pattern) =>
    name.toUpperCase().includes(pattern),
  );
}

async function promptForCredentials(
  type: ModelProviderType,
  authMethod: string,
): Promise<Record<string, string>> {
  const credentialsConfig = getCredentialsForAuthMethod(type, authMethod);

  if (!credentialsConfig) {
    console.error(chalk.red(`✗ Invalid auth method "${authMethod}"`));
    process.exit(1);
  }

  const credentials: Record<string, string> = {};

  for (const [name, fieldConfig] of Object.entries(credentialsConfig)) {
    if (fieldConfig.helpText) {
      console.log(chalk.dim(fieldConfig.helpText));
    }

    const isSecret = isSecretCredential(name);
    const placeholder =
      "placeholder" in fieldConfig ? (fieldConfig.placeholder as string) : "";

    if (fieldConfig.required) {
      const response = await prompts(
        {
          type: isSecret ? "password" : "text",
          name: "value",
          message: `${fieldConfig.label}:`,
          initial: placeholder ? "" : undefined,
          validate: (value: string) =>
            value.length > 0 || `${fieldConfig.label} is required`,
        },
        { onCancel: () => process.exit(0) },
      );
      credentials[name] = response.value as string;
    } else {
      // Optional field
      const response = await prompts(
        {
          type: isSecret ? "password" : "text",
          name: "value",
          message: `${fieldConfig.label} (optional):`,
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

  // Check if credential already exists
  const checkResult = await checkModelProviderCredential(type);

  // Handle existing model-provider credential
  if (checkResult.exists) {
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

  // Handle multi-auth providers
  if (hasAuthMethods(type)) {
    const authMethod = await promptForAuthMethod(type);
    const credentials = await promptForCredentials(type, authMethod);
    const selectedModel = await promptForModelSelection(type);

    return {
      type,
      authMethod,
      credentials,
      selectedModel,
      isInteractiveMode: true,
    };
  }

  // Single-credential provider (legacy)
  const credentialLabel =
    "credentialLabel" in config ? config.credentialLabel : "credential";

  const credentialResponse = await prompts(
    {
      type: "password",
      name: "credential",
      message: `Enter your ${credentialLabel}:`,
      validate: (value: string) =>
        value.length > 0 || `${credentialLabel} is required`,
    },
    { onCancel: () => process.exit(0) },
  );

  const credential = credentialResponse.credential as string;
  const selectedModel = await promptForModelSelection(type);

  return { type, credential, selectedModel, isInteractiveMode: true };
}

function handleSetupError(error: unknown): never {
  if (error instanceof Error) {
    if (error.message.includes("Not authenticated")) {
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
    "Auth method (required for multi-auth providers like aws-bedrock)",
  )
  .option("-m, --model <model>", "Model selection (for non-interactive mode)")
  .action(
    async (options: {
      type?: string;
      credential?: string[];
      authMethod?: string;
      model?: string;
    }) => {
      try {
        let input: SetupInput;
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
