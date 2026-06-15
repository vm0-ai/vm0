import { Command } from "commander";
import chalk from "chalk";

import {
  getZeroBillingStatus,
  getZeroOrg,
  getZeroOrgMembers,
} from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

function memberName(member: {
  readonly email: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
}): string {
  const name = [member.firstName, member.lastName].filter(Boolean).join(" ");
  return name ? `${name} <${member.email}>` : member.email;
}

export const creditCommand = new Command()
  .name("credit")
  .description("Diagnose current organization credit and purchase access")
  .action(
    withErrorHandler(async () => {
      const [org, billing, members] = await Promise.all([
        getZeroOrg(),
        getZeroBillingStatus(),
        getZeroOrgMembers(),
      ]);
      const admins = members.members.filter((member) => {
        return member.role === "admin";
      });
      const isAdmin = members.role === "admin";
      const canPurchaseCredits = isAdmin;

      console.log(chalk.bold("Credit diagnostics:"));
      console.log(`  Org: ${chalk.green(org.slug)}`);
      console.log(`  Tier: ${chalk.cyan(billing.tier)}`);
      console.log(
        `  Available credits: ${chalk.cyan(billing.credits.toLocaleString())}`,
      );
      console.log(`  Current user role: ${chalk.cyan(members.role)}`);
      console.log(
        `  Can purchase credits: ${
          canPurchaseCredits ? chalk.green("yes") : chalk.yellow("no")
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

      if (!isAdmin) {
        console.log(chalk.bold("\nOrganization admins:"));
        for (const admin of admins) {
          console.log(`  - ${memberName(admin)}`);
        }
        console.log(
          chalk.yellow(
            "\nAsk an organization admin to buy credits or upgrade the plan.",
          ),
        );
      } else if (billing.tier === "free") {
        console.log(
          "\nFree-tier admins can upgrade to Pro from billing or buy credits with `zero credit <credits>`.",
        );
      } else {
        console.log("\nUse `zero credit <credits>` to buy more credits.");
      }
    }),
  );
