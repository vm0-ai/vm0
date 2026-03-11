import { Command } from "commander";
import chalk from "chalk";
import { listScopes } from "../../lib/api";
import { saveConfig } from "../../lib/api/config";
import { withErrorHandler } from "../../lib/command";

export const useCommand = new Command()
  .name("use")
  .description("Switch to a different scope")
  .argument("[slug]", "Scope slug to switch to")
  .option("--personal", "Switch to personal scope")
  .action(
    withErrorHandler(
      async (slug: string | undefined, options: { personal?: boolean }) => {
        if (options.personal) {
          await saveConfig({ activeScope: undefined });
          console.log(chalk.green("✓ Switched to default scope."));
          return;
        }

        if (!slug) {
          console.error(
            chalk.red(
              "✗ Scope slug is required. Use --personal to switch to default scope.",
            ),
          );
          process.exit(1);
        }

        // Verify the scope exists and user has access
        const scopeList = await listScopes();
        const target = scopeList.scopes.find((s) => s.slug === slug);
        if (!target) {
          console.error(
            chalk.red(`✗ Scope '${slug}' not found or not accessible.`),
          );
          process.exit(1);
        }

        await saveConfig({ activeScope: slug });
        console.log(chalk.green(`✓ Switched to scope: ${slug}`));
      },
    ),
  );
