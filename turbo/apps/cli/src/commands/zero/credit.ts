import { Command, Option } from "commander";
import chalk from "chalk";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";

import {
  createZeroCreditCheckout,
  getZeroBillingStatus,
  getZeroOrgMembers,
} from "../../lib/api";
import { withErrorHandler } from "../../lib/command";
import { decodeZeroTokenPayload } from "../../lib/api/zero-token";
import { getPlatformOrigin } from "./doctor/platform-url";

function parseCredits(value: string): number {
  const credits = Number(value.replaceAll(",", ""));
  if (!Number.isInteger(credits) || credits <= 0) {
    throw new Error("credits must be a positive integer");
  }
  return credits;
}

function requireZeroCapabilityForCreditAction(
  capability: ZeroCapability,
  message: string,
): void {
  const payload = decodeZeroTokenPayload();
  if (payload && !payload.capabilities.includes(capability)) {
    throw new Error(message);
  }
}

interface CreditBuyOptions {
  readonly autoRecharge?: boolean;
  readonly autoRechargeThreshold?: number;
  readonly autoRechargeAmount?: number;
}

function addBuyOptions(command: Command): Command {
  return command
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
    );
}

function validateBuyOptions(options: CreditBuyOptions): void {
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
}

async function showCreditStatus(): Promise<void> {
  requireZeroCapabilityForCreditAction(
    "billing:read",
    "checking credit status requires billing:read capability",
  );

  const billing = await getZeroBillingStatus();
  console.log(chalk.bold("Credit status:"));
  console.log(`  Tier: ${chalk.cyan(billing.tier)}`);
  console.log(
    `  Available credits: ${chalk.cyan(billing.credits.toLocaleString())}`,
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
}

async function buyCredits(
  credits: number,
  options: CreditBuyOptions,
): Promise<void> {
  requireZeroCapabilityForCreditAction(
    "billing:write",
    "buying credits requires billing:write capability",
  );
  validateBuyOptions(options);

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
}

const creditStatusCommand = new Command()
  .name("status")
  .description("View credit balance and auto-recharge status")
  .action(withErrorHandler(showCreditStatus));

const creditBuyCommand = addBuyOptions(
  new Command()
    .name("buy")
    .description("Create a checkout link to buy credits")
    .argument("<credits>", "Number of credits to buy", parseCredits),
).action(
  withErrorHandler(async (credits: number, options: CreditBuyOptions) => {
    await buyCredits(credits, options);
  }),
);

export const zeroCreditCommand = addBuyOptions(
  new Command()
    .name("credit")
    .description("View credit balance or buy credits")
    .argument("[credits]", "Number of credits to buy", parseCredits),
)
  .enablePositionalOptions()
  .addCommand(creditStatusCommand)
  .addCommand(creditBuyCommand)
  .action(
    withErrorHandler(
      async (
        credits: number | undefined,
        options: CreditBuyOptions,
        command: Command,
      ) => {
        if (credits === undefined) {
          if (
            options.autoRecharge === true ||
            options.autoRechargeThreshold !== undefined ||
            options.autoRechargeAmount !== undefined
          ) {
            throw new Error("credit amount is required for auto-recharge");
          }
          command.outputHelp();
          return;
        }

        await buyCredits(credits, options);
      },
    ),
  )
  .addHelpText(
    "after",
    `
Examples:
  Check credits:  zero credit status
  Buy credits:    zero credit buy 20000
  Shorthand buy:  zero credit 20000`,
  );
