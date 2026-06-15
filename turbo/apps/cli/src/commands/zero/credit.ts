import { Command, Option } from "commander";
import chalk from "chalk";

import { createZeroCreditCheckout, getZeroOrgMembers } from "../../lib/api";
import { withErrorHandler } from "../../lib/command";
import { getPlatformOrigin } from "./doctor/platform-url";

function parseCredits(value: string): number {
  const credits = Number(value.replaceAll(",", ""));
  if (!Number.isInteger(credits) || credits <= 0) {
    throw new Error("credits must be a positive integer");
  }
  return credits;
}

export const zeroCreditCommand = new Command()
  .name("credit")
  .description("Create a Stripe checkout link to buy credits")
  .argument("<credits>", "Number of credits to buy", parseCredits)
  .addOption(
    new Option("--auto-recharge", "Enable auto-recharge after checkout"),
  )
  .option(
    "--auto-recharge-threshold <credits>",
    "Recharge when balance is at or below this number of credits",
    parseCredits,
  )
  .option(
    "--auto-recharge-amount <credits>",
    "Credits to buy for each auto-recharge",
    parseCredits,
  )
  .action(
    withErrorHandler(
      async (
        credits: number,
        options: {
          readonly autoRecharge?: boolean;
          readonly autoRechargeThreshold?: number;
          readonly autoRechargeAmount?: number;
        },
      ) => {
        const members = await getZeroOrgMembers();
        if (members.role !== "admin") {
          console.log(
            chalk.yellow(
              "Only organization admins can buy credits. Run `zero doctor credit` to see the current credit status and org admins.",
            ),
          );
          return;
        }

        const origin = await getPlatformOrigin();
        const successUrl = `${origin}/?settings=usage&credit=success`;
        const cancelUrl = `${origin}/?settings=usage&credit=canceled`;
        if (
          options.autoRecharge !== true &&
          (options.autoRechargeThreshold !== undefined ||
            options.autoRechargeAmount !== undefined)
        ) {
          throw new Error(
            "--auto-recharge-threshold and --auto-recharge-amount require --auto-recharge",
          );
        }

        if (
          options.autoRecharge === true &&
          (options.autoRechargeThreshold === undefined ||
            options.autoRechargeAmount === undefined)
        ) {
          throw new Error(
            "--auto-recharge requires --auto-recharge-threshold and --auto-recharge-amount",
          );
        }

        const autoRecharge =
          options.autoRecharge === true
            ? {
                enabled: true,
                threshold: options.autoRechargeThreshold,
                amount: options.autoRechargeAmount,
              }
            : undefined;

        const result = await createZeroCreditCheckout({
          credits,
          successUrl,
          cancelUrl,
          ...(autoRecharge ? { autoRecharge } : {}),
        });
        console.log(chalk.bold("Credit checkout link:"));
        console.log(result.url);
      },
    ),
  );
