import { Command } from "commander";
import chalk from "chalk";
import prompts from "prompts";
import {
  upsertModelProvider,
  checkModelProviderCredential,
  convertModelProviderCredential,
} from "../../lib/api";
import { MODEL_PROVIDER_TYPES, type ModelProviderType } from "@vm0/core";
import { isInteractive } from "../../lib/utils/prompt-utils";

const providerChoices = Object.entries(MODEL_PROVIDER_TYPES).map(
  ([type, config]) => ({
    title: config.label,
    value: type as ModelProviderType,
  }),
);

export const setupCommand = new Command()
  .name("setup")
  .description("Configure a model provider")
  .option("-t, --type <type>", "Provider type (for non-interactive mode)")
  .option(
    "-c, --credential <credential>",
    "Credential value (for non-interactive mode)",
  )
  .option("--convert", "Convert existing user credential to model provider")
  .action(
    async (options: {
      type?: string;
      credential?: string;
      convert?: boolean;
    }) => {
      try {
        let type: ModelProviderType;
        let credential: string;
        const shouldConvert = options.convert ?? false;

        // Non-interactive mode
        if (options.type && options.credential) {
          if (!Object.keys(MODEL_PROVIDER_TYPES).includes(options.type)) {
            console.error(chalk.red(`✗ Invalid type "${options.type}"`));
            console.log();
            console.log("Valid types:");
            for (const [t, config] of Object.entries(MODEL_PROVIDER_TYPES)) {
              console.log(`  ${chalk.cyan(t)} - ${config.label}`);
            }
            process.exit(1);
          }
          type = options.type as ModelProviderType;
          credential = options.credential;
        } else if (options.type || options.credential) {
          console.error(
            chalk.red("✗ Both --type and --credential are required"),
          );
          process.exit(1);
        } else {
          // Interactive mode
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

          const typeResponse = await prompts(
            {
              type: "select",
              name: "type",
              message: "Select provider type:",
              choices: providerChoices,
            },
            { onCancel: () => process.exit(0) },
          );

          type = typeResponse.type;

          // Check if credential already exists
          const checkResult = await checkModelProviderCredential(type);

          if (checkResult.exists && checkResult.currentType === "user") {
            // Ask user if they want to convert
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
              // Convert without re-entering credential
              const provider = await convertModelProviderCredential(type);
              const defaultNote = provider.isDefault
                ? ` (default for ${provider.framework})`
                : "";
              console.log(
                chalk.green(
                  `✓ Converted "${checkResult.credentialName}" to model provider${defaultNote}`,
                ),
              );
              return;
            } else {
              console.log(chalk.dim("Aborted"));
              process.exit(0);
            }
          }

          const config = MODEL_PROVIDER_TYPES[type];

          // Display help text for obtaining credentials
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

          credential = credentialResponse.credential;
        }

        // Create/update model provider
        const { provider, created } = await upsertModelProvider({
          type,
          credential,
          convert: shouldConvert,
        });

        const action = created ? "created" : "updated";
        const defaultNote = provider.isDefault
          ? ` (default for ${provider.framework})`
          : "";
        console.log(
          chalk.green(`✓ Model provider "${type}" ${action}${defaultNote}`),
        );
      } catch (error) {
        if (error instanceof Error) {
          if (error.message.includes("already exists")) {
            console.error(chalk.red(`✗ ${error.message}`));
            console.log();
            console.log("To convert the existing credential, run:");
            console.log(chalk.cyan("  vm0 model-provider setup --convert"));
          } else if (error.message.includes("Not authenticated")) {
            console.error(
              chalk.red("✗ Not authenticated. Run: vm0 auth login"),
            );
          } else {
            console.error(chalk.red(`✗ ${error.message}`));
          }
        } else {
          console.error(chalk.red("✗ An unexpected error occurred"));
        }
        process.exit(1);
      }
    },
  );
