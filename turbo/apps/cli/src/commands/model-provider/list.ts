import { Command } from "commander";
import chalk from "chalk";
import { listModelProviders } from "../../lib/api";
import { withErrorHandler } from "../../lib/command";

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List all model providers")
  .action(
    withErrorHandler(async () => {
      const result = await listModelProviders();

      if (result.modelProviders.length === 0) {
        console.log(chalk.dim("No model providers configured"));
        console.log();
        console.log("To add a model provider:");
        console.log(chalk.cyan("  vm0 model-provider setup"));
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

      console.log(chalk.bold("Model Providers:"));
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
    }),
  );
