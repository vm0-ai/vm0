import { Command } from "commander";
import chalk from "chalk";
import {
  MODEL_PROVIDER_TYPES,
  allowsCustomModel,
  getModels,
  type ModelProviderType,
} from "@vm0/core/contracts/model-providers";
import { listZeroOrgModelProviders } from "../../../../lib/api";
import { withErrorHandler } from "../../../../lib/command";

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List all org-level model providers")
  .action(
    withErrorHandler(async () => {
      const result = await listZeroOrgModelProviders();

      if (result.modelProviders.length === 0) {
        console.log(chalk.dim("No org-level model providers configured"));
        console.log();
        console.log("To add an org-level model provider:");
        console.log(chalk.cyan("  zero org model-provider setup"));
        return;
      }

      // Group by framework
      const byFramework = result.modelProviders.reduce(
        (acc, p) => {
          const fw = p.framework;
          if (!acc[fw]) {
            acc[fw] = [];
          }
          acc[fw].push(p);
          return acc;
        },
        {} as Record<string, typeof result.modelProviders>,
      );

      console.log(chalk.bold("Org Model Providers:"));
      console.log();

      for (const [framework, providers] of Object.entries(byFramework)) {
        console.log(`  ${chalk.cyan(framework)}:`);
        for (const provider of providers) {
          const defaultTag = provider.isDefault
            ? chalk.green(" (default)")
            : "";
          const modelTag = provider.selectedModel
            ? chalk.dim(` [${provider.selectedModel}]`)
            : "";
          console.log(`    ${provider.type}${defaultTag}${modelTag}`);
          console.log(chalk.dim(`      ID: ${provider.id}`));
          if (provider.type in MODEL_PROVIDER_TYPES) {
            const type = provider.type as ModelProviderType;
            const available = getModels(type) ?? [];
            if (available.length > 0) {
              console.log(
                chalk.dim(`      Available models: ${available.join(", ")}`),
              );
            } else if (allowsCustomModel(type)) {
              console.log(
                chalk.dim("      Available models: (custom — any model name)"),
              );
            }
          }
          console.log(
            chalk.dim(
              `      Updated: ${new Date(provider.updatedAt).toLocaleString()}`,
            ),
          );
        }
        console.log();
      }

      console.log(
        chalk.dim(`Total: ${result.modelProviders.length} provider(s)`),
      );
      console.log();
      console.log(
        chalk.dim(
          "Use a provider ID with: zero agent edit <agent-id> --model-provider <id> --model <name>",
        ),
      );
    }),
  );
