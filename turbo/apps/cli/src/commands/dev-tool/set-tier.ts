import { Command } from "commander";
import chalk from "chalk";
import { httpPut } from "../../lib/api/core/http";
import { withErrorHandler } from "../../lib/command";

export const setTierCommand = new Command()
  .name("set-tier")
  .description("Set scope tier (admin only)")
  .argument("<scope-slug>", "The scope slug to update")
  .argument("<tier>", "The tier to set (free, pro, or max)")
  .action(
    withErrorHandler(async (slug: string, tier: string) => {
      if (tier !== "free" && tier !== "pro" && tier !== "max") {
        console.error(
          chalk.red(`Invalid tier: ${tier}. Must be "free", "pro", or "max"`),
        );
        process.exit(1);
      }

      const response = await httpPut("/api/admin/scope/tier", { slug, tier });

      if (!response.ok) {
        const error = (await response.json()) as {
          error?: { message?: string };
        };
        throw new Error(error.error?.message || `Failed: ${response.status}`);
      }

      const result = (await response.json()) as {
        slug: string;
        tier: string;
      };
      console.log(
        chalk.green(
          `Scope "${result.slug}" tier set to ${chalk.bold(result.tier)}`,
        ),
      );
    }),
  );
