import { Command } from "commander";
import chalk from "chalk";
import { useScope } from "../../lib/api";
import { setOrgToken, clearOrgToken } from "../../lib/api/config";

export const useCommand = new Command()
  .name("use")
  .description("Switch to a different scope")
  .argument("[slug]", "Scope slug to switch to")
  .option("--personal", "Switch to personal scope")
  .action(async (slug: string | undefined, options: { personal?: boolean }) => {
    try {
      if (options.personal) {
        await clearOrgToken();
        console.log(chalk.green("✓ Switched to personal scope."));
        return;
      }

      if (!slug) {
        console.error(
          chalk.red(
            "✗ Scope slug is required. Use --personal to switch to personal scope.",
          ),
        );
        process.exit(1);
      }

      const result = await useScope(slug);

      if (result.token) {
        await setOrgToken(result.token, result.expiresAt, result.scope.slug);
        const label =
          result.scope.type === "system" ? "system" : "organization";
        console.log(
          chalk.green(`✓ Switched to scope: ${result.scope.slug} (${label})`),
        );
      } else {
        await clearOrgToken();
        console.log(
          chalk.green(`✓ Switched to scope: ${result.scope.slug} (personal)`),
        );
      }
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red(`✗ ${error.message}`));
      } else {
        console.error(chalk.red("✗ An unexpected error occurred"));
      }
      process.exit(1);
    }
  });
