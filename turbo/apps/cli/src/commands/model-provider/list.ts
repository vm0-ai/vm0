import { Command } from "commander";
import chalk from "chalk";
import { listModelProviders } from "../../lib/api";

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List all model providers")
  .action(async () => {
    try {
      const result = await listModelProviders();

      if (result.modelProviders.length === 0) {
        console.log(chalk.dim("No model providers configured."));
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
          console.log(`    ${provider.type}${defaultTag}`);
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
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes("Not authenticated")) {
          console.error(chalk.red("x Not authenticated. Run: vm0 auth login"));
        } else {
          console.error(chalk.red(`x ${error.message}`));
        }
      } else {
        console.error(chalk.red("x An unexpected error occurred"));
      }
      process.exit(1);
    }
  });
