import { Command } from "commander";
import chalk from "chalk";
import { listZeroOrgModelProviders } from "../../../../lib/api";
import { withErrorHandler } from "../../../../lib/command";

interface CreateListCommandOptions {
  scopeLabel?: string;
  title?: string;
  setupCommand?: string;
}

export function createListCommand(
  options: CreateListCommandOptions = {},
): Command {
  const scopeLabel = options.scopeLabel ?? "org-level";
  const title = options.title ?? "Org Model Providers";
  const setupCommand = options.setupCommand ?? "zero org model-provider setup";

  return new Command()
    .name("list")
    .alias("ls")
    .description(`List all ${scopeLabel} model providers`)
    .action(
      withErrorHandler(async () => {
        const result = await listZeroOrgModelProviders();

        if (result.modelProviders.length === 0) {
          console.log(chalk.dim(`No ${scopeLabel} model providers configured`));
          console.log();
          console.log(`To add a ${scopeLabel} model provider:`);
          console.log(chalk.cyan(`  ${setupCommand}`));
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

        console.log(chalk.bold(`${title}:`));
        console.log();

        for (const [framework, providers] of Object.entries(byFramework)) {
          console.log(`  ${chalk.cyan(framework)}:`);
          for (const provider of providers) {
            console.log(`    ${provider.type}`);
            console.log(chalk.dim(`      ID: ${provider.id}`));
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
}

export const listCommand = createListCommand();
