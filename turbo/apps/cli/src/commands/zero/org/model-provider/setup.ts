import { Command } from "commander";
import chalk from "chalk";
import prompts from "prompts";
import {
  listZeroOrgModelProviders,
  upsertZeroOrgModelProvider,
} from "../../../../lib/api";
import {
  MODEL_PROVIDER_TYPES,
  hasAuthMethods,
  getSelectableProviderTypes,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import { isInteractive } from "../../../../lib/utils/prompt-utils";
import { withErrorHandler } from "../../../../lib/command";
import {
  type SetupInput,
  handleNonInteractiveMode,
  promptForAuthMethod,
  promptForSecrets,
  collectSecrets,
} from "../../../../lib/domain/model-provider/shared";

interface CreateSetupCommandOptions {
  commandPrefix?: string;
  description?: string;
  scopeLabel?: string;
}

async function handleInteractiveMode(
  commandPrefix: string,
): Promise<SetupInput | null> {
  if (!isInteractive()) {
    throw new Error("Interactive mode requires a TTY", {
      cause: new Error(
        `Use non-interactive mode: ${commandPrefix} --type <type> --secret "<value>"`,
      ),
    });
  }

  let cancelled = false;
  const onCancel = () => {
    cancelled = true;
    return false;
  };

  // Fetch configured org providers to annotate choices
  const { modelProviders: configuredProviders } =
    await listZeroOrgModelProviders();
  const configuredTypes = new Set(
    configuredProviders.map((p) => {
      return p.type;
    }),
  );

  // Build provider choices with configuration status (only selectable providers)
  const annotatedChoices = getSelectableProviderTypes().map((type) => {
    const config = MODEL_PROVIDER_TYPES[type];
    const isConfigured = configuredTypes.has(type);
    const isExperimental = hasAuthMethods(type);
    let title: string = config.label;
    if (isConfigured) {
      title = `${title} ✓`;
    }
    if (isExperimental) {
      title = `${title} ${chalk.dim("(experimental)")}`;
    }
    return {
      title,
      value: type,
    };
  });

  const typeResponse = await prompts(
    {
      type: "select",
      name: "type",
      message: "Select provider type:",
      choices: annotatedChoices,
    },
    { onCancel },
  );

  if (cancelled) {
    console.log(chalk.dim("Cancelled"));
    return null;
  }

  const type = typeResponse.type as ModelProviderType;

  // Check if provider is already configured using the list we already fetched
  const existingProvider = configuredProviders.find((p) => {
    return p.type === type;
  });

  if (existingProvider) {
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
      { onCancel },
    );

    if (cancelled) {
      console.log(chalk.dim("Cancelled"));
      return null;
    }

    if (actionResponse.action === "keep") {
      return {
        type,
        keepExistingSecret: true,
        isInteractiveMode: true,
      };
    }
    // Fall through to secret prompt for "update"
  }

  const config = MODEL_PROVIDER_TYPES[type];

  console.log();
  if ("helpText" in config) {
    console.log(chalk.dim(config.helpText));
  }
  console.log();

  // Handle multi-auth providers
  if (hasAuthMethods(type)) {
    const authMethod = await promptForAuthMethod(type);
    const secrets = await promptForSecrets(type, authMethod);

    return {
      type,
      authMethod,
      secrets,
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
      validate: (value: string) => {
        return value.length > 0 || `${secretLabel} is required`;
      },
    },
    { onCancel },
  );

  if (cancelled) {
    console.log(chalk.dim("Cancelled"));
    return null;
  }

  const secret = secretResponse.secret as string;

  return { type, secret, isInteractiveMode: true };
}

export function createSetupCommand(
  options: CreateSetupCommandOptions = {},
): Command {
  const commandPrefix =
    options.commandPrefix ?? "zero org model-provider setup";
  const description =
    options.description ?? "Configure an org-level model provider";
  const scopeLabel = options.scopeLabel ?? "Org";

  return new Command()
    .name("setup")
    .description(description)
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
    .action(
      withErrorHandler(
        async (options: {
          type?: string;
          secret?: string[];
          authMethod?: string;
        }) => {
          let input: SetupInput;
          const secretArgs = options.secret ?? [];

          if (options.type && secretArgs.length > 0) {
            input = handleNonInteractiveMode({
              type: options.type,
              secret: secretArgs,
              authMethod: options.authMethod,
              commandPrefix,
            });
          } else if (options.type || secretArgs.length > 0) {
            throw new Error("Both --type and --secret are required");
          } else {
            const result = await handleInteractiveMode(commandPrefix);
            if (result === null) {
              return;
            }
            input = result;
          }

          // Handle "keep existing secret" flow
          if (input.keepExistingSecret) {
            console.log(
              chalk.green(
                `✓ ${scopeLabel} model provider "${input.type}" unchanged`,
              ),
            );
            return;
          }

          // Standard upsert flow with secret
          const { created } = await upsertZeroOrgModelProvider({
            type: input.type,
            secret: input.secret,
            authMethod: input.authMethod,
            secrets: input.secrets,
          });

          const action = created ? "created" : "updated";
          console.log(
            chalk.green(
              `✓ ${scopeLabel} model provider "${input.type}" ${action}`,
            ),
          );
        },
      ),
    );
}

export const setupCommand = createSetupCommand();
