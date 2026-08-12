import { Command } from "commander";
import chalk from "chalk";

import { getZeroBillingStatus } from "../../../lib/api/domains/zero-billing";
import { getZeroOrg } from "../../../lib/api/domains/zero-orgs";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
import { getPlatformOrigin } from "./platform-url";
import {
  currentPlanAllowsVideo,
  currentPlanCanBuyCredits,
} from "../shared/billing-capabilities";
import { planUpgradeUrl } from "../shared/billing-links";

export const creditCommand = new Command()
  .name("credit")
  .description("Diagnose current organization credit and purchase access")
  .action(
    withErrorHandler(async () => {
      const [org, billing, platformOrigin] = await Promise.all([
        getZeroOrg(),
        getZeroBillingStatus(),
        getPlatformOrigin(),
      ]);
      const planCanBuyCredits = currentPlanCanBuyCredits(billing);

      console.log(chalk.bold("Credit diagnostics:"));
      console.log(`  Workspace: ${chalk.green(org.name)}`);
      console.log(`  Tier: ${chalk.cyan(billing.tier)}`);
      console.log(
        `  Available credits: ${chalk.cyan(billing.credits.toLocaleString())}`,
      );
      console.log(
        `  Plan can purchase credits: ${
          planCanBuyCredits ? chalk.green("yes") : chalk.yellow("no")
        }`,
      );
      console.log(
        `  Built-in video generation: ${
          currentPlanAllowsVideo(billing)
            ? chalk.green("available")
            : chalk.yellow("unavailable")
        }`,
      );
      console.log(
        `  Auto-recharge: ${
          billing.autoRecharge.enabled ? chalk.green("enabled") : "disabled"
        }`,
      );
      if (billing.autoRecharge.enabled) {
        console.log(
          `    Threshold: ${billing.autoRecharge.threshold?.toLocaleString() ?? "not set"}`,
        );
        console.log(
          `    Amount: ${billing.autoRecharge.amount?.toLocaleString() ?? "not set"}`,
        );
      }

      if (!planCanBuyCredits) {
        console.log(
          "\nThis workspace plan cannot buy credits. A workspace admin has to upgrade the plan instead:",
        );
        console.log(planUpgradeUrl(platformOrigin));
        return;
      }

      if (billing.tier === "free") {
        console.log(
          "\nWorkspace admins can upgrade to Pro from billing or buy credits with `okou credit <credits>`.",
        );
      } else {
        console.log(
          "\nWorkspace admins can use `okou credit <credits>` to buy more credits.",
        );
      }
    }),
  );
