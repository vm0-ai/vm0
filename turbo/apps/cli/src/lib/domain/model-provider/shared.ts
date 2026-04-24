import chalk from "chalk";
import prompts from "prompts";
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
} from "@vm0/core/contracts/model-providers";

export interface SetupInput {
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
    const validTypes = Object.keys(MODEL_PROVIDER_TYPES).join(", ");
    throw new Error(`Invalid type "${typeStr}"`, {
      cause: new Error(`Valid types: ${validTypes}`),
    });
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
    throw new Error(`Invalid model "${modelStr}"`, {
      cause: new Error(`Valid models: ${models.join(", ")}`),
    });
  }
  return modelStr;
}

function validateAuthMethod(
  type: ModelProviderType,
  authMethodStr: string,
): string | never {
  const authMethods = getAuthMethodsForType(type);
  if (!authMethods || !(authMethodStr in authMethods)) {
    const validMethods = authMethods
      ? Object.keys(authMethods).join(", ")
      : "none";
    throw new Error(`Invalid auth method "${authMethodStr}"`, {
      cause: new Error(`Valid auth methods: ${validMethods}`),
    });
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
    throw new Error(`Invalid auth method "${authMethod}"`);
  }

  const secretNames = Object.keys(secretsConfig);

  // Single value without = sign: only allowed for single-secret auth methods
  const firstArg = secretArgs[0];
  if (secretArgs.length === 1 && firstArg && !firstArg.includes("=")) {
    if (secretNames.length !== 1) {
      throw new Error(
        "Must use KEY=VALUE format for multi-secret auth methods",
        { cause: new Error(`Required secrets: ${secretNames.join(", ")}`) },
      );
    }
    const firstSecretName = secretNames[0];
    if (!firstSecretName) {
      throw new Error("No secrets defined for this auth method");
    }
    return { [firstSecretName]: firstArg };
  }

  // KEY=VALUE format
  const secrets: Record<string, string> = {};
  for (const arg of secretArgs) {
    const eqIndex = arg.indexOf("=");
    if (eqIndex === -1) {
      throw new Error(`Invalid secret format "${arg}"`, {
        cause: new Error("Use KEY=VALUE format (e.g., AWS_REGION=us-east-1)"),
      });
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
    throw new Error(`Invalid auth method "${authMethod}"`);
  }

  // Check required fields
  for (const [name, fieldConfig] of Object.entries(secretsConfig)) {
    if (fieldConfig.required && !secrets[name]) {
      const requiredNames = Object.entries(secretsConfig)
        .filter(([, fc]) => {
          return fc.required;
        })
        .map(([n]) => {
          return n;
        })
        .join(", ");
      throw new Error(`Missing required secret: ${name}`, {
        cause: new Error(`Required secrets: ${requiredNames}`),
      });
    }
  }

  // Check for unknown fields
  for (const name of Object.keys(secrets)) {
    if (!(name in secretsConfig)) {
      const validNames = Object.keys(secretsConfig).join(", ");
      throw new Error(`Unknown secret: ${name}`, {
        cause: new Error(`Valid secrets: ${validNames}`),
      });
    }
  }
}

export function handleNonInteractiveMode(options: {
  type: string;
  secret: string[];
  authMethod?: string;
  model?: string;
  commandPrefix?: string;
}): SetupInput {
  const type = validateProviderType(options.type);
  const cmdPrefix = options.commandPrefix ?? "zero org model-provider setup";

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
        throw new Error(`Provider "${type}" requires --auth-method`);
      }
      // If there's only one auth method, use it; otherwise require explicit selection
      const authMethodNames = Object.keys(authMethods);
      if (authMethodNames.length === 1) {
        authMethod = authMethodNames[0]!;
      } else {
        const methods = authMethodNames.join(", ");
        throw new Error(
          `--auth-method is required for "${type}" (multiple auth methods available)`,
          {
            cause: new Error(
              `Available: ${methods}. Example: ${cmdPrefix} --type ${type} --auth-method ${authMethodNames[0]} --secret KEY=VALUE`,
            ),
          },
        );
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
    throw new Error("Secret is required");
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

export async function promptForModelSelection(
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
    {
      onCancel: () => {
        return process.exit(0);
      },
    },
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
        validate: (value: string) => {
          return value.length > 0 || "Model ID is required";
        },
      },
      {
        onCancel: () => {
          return process.exit(0);
        },
      },
    );
    return customResponse.customModel as string;
  }

  // Return undefined for auto mode (empty string)
  return selected === "" ? undefined : selected;
}

/**
 * Prompt for auth method selection (only for multi-auth providers)
 */
export async function promptForAuthMethod(
  type: ModelProviderType,
): Promise<string> {
  const authMethods = getAuthMethodsForType(type);
  const defaultAuthMethod = getDefaultAuthMethod(type);

  if (!authMethods) {
    return "default";
  }

  const choices = Object.entries(authMethods).map(([method, config]) => {
    return {
      title:
        method === defaultAuthMethod
          ? `${config.label} (Recommended)`
          : config.label,
      value: method,
    };
  });

  const response = await prompts(
    {
      type: "select",
      name: "authMethod",
      message: "Select authentication method:",
      choices,
    },
    {
      onCancel: () => {
        return process.exit(0);
      },
    },
  );

  return response.authMethod as string;
}

/**
 * Determine if a secret should be masked (password type)
 * Non-secret values like region should be visible
 */
function isSensitiveSecret(name: string): boolean {
  const nonSecretPatterns = ["REGION", "ENDPOINT", "URL"];
  return !nonSecretPatterns.some((pattern) => {
    return name.toUpperCase().includes(pattern);
  });
}

export async function promptForSecrets(
  type: ModelProviderType,
  authMethod: string,
): Promise<Record<string, string>> {
  const secretsConfig = getSecretsForAuthMethod(type, authMethod);

  if (!secretsConfig) {
    throw new Error(`Invalid auth method "${authMethod}"`);
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
          validate: (value: string) => {
            return value.length > 0 || `${fieldConfig.label} is required`;
          },
        },
        {
          onCancel: () => {
            return process.exit(0);
          },
        },
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
        {
          onCancel: () => {
            return process.exit(0);
          },
        },
      );
      const value = response.value as string;
      if (value && value.trim()) {
        secrets[name] = value.trim();
      }
    }
  }

  return secrets;
}

/**
 * Collect secret values from repeatable --secret option
 */
export function collectSecrets(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

/**
 * Parse a CLI model/model-provider flag value.
 *
 * Returns:
 *   - `undefined` when the flag was not provided (preserve existing value)
 *   - `null` when the user passed "default" (clear the override, inherit from org)
 *   - the string value otherwise (set the specific model/provider)
 */
export function parseModelFlag(
  value: string | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === "default") return null;
  return value;
}
