import { Command, InvalidArgumentError } from "commander";
import chalk from "chalk";

import { callZeroBanking, type ZeroBankingResponse } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

interface JsonOption {
  readonly json?: boolean;
}

interface BalancesOptions extends JsonOption {
  readonly accountId: string;
}

interface TransactionsOptions extends JsonOption {
  readonly accountId: string;
  readonly from: string;
  readonly to: string;
  readonly limit: number;
}

function parseLimit(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
    throw new InvalidArgumentError("limit must be between 1 and 1000");
  }
  return parsed;
}

function parseDateOnly(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new InvalidArgumentError("date must be formatted as YYYY-MM-DD");
  }
  return value;
}

function renderBankingResponse(
  label: string,
  response: ZeroBankingResponse,
): void {
  console.log(chalk.green(`✓ ${label}`));
  console.log(chalk.dim(`  Provider: ${response.provider}`));

  if (response.accounts) {
    console.log(JSON.stringify(response.accounts, null, 2));
    return;
  }
  if (response.balance) {
    console.log(JSON.stringify(response.balance, null, 2));
    return;
  }
  console.log(JSON.stringify(response.transactions ?? [], null, 2));
}

async function runBankingRequest(
  label: string,
  operation: "accounts" | "balances" | "transactions",
  payload: Record<string, unknown>,
  options: JsonOption,
): Promise<void> {
  const response = await callZeroBanking(operation, payload);
  if (options.json) {
    console.log(JSON.stringify(response));
    return;
  }
  renderBankingResponse(label, response);
}

const accountsCommand = new Command()
  .name("accounts")
  .description("List enabled banking accounts")
  .option("--json", "Print the raw banking response as JSON")
  .action(
    withErrorHandler(async (options: JsonOption) => {
      await runBankingRequest(
        "Banking accounts loaded",
        "accounts",
        {},
        options,
      );
    }),
  );

const balancesCommand = new Command()
  .name("balances")
  .description("Read an enabled account balance")
  .requiredOption("--account-id <id>", "Enabled provider account ID")
  .option("--json", "Print the raw banking response as JSON")
  .action(
    withErrorHandler(async (options: BalancesOptions) => {
      await runBankingRequest(
        "Banking balance loaded",
        "balances",
        { accountId: options.accountId },
        options,
      );
    }),
  );

const transactionsCommand = new Command()
  .name("transactions")
  .description("Read transactions for an enabled account")
  .requiredOption("--account-id <id>", "Enabled provider account ID")
  .requiredOption(
    "--from <date>",
    "Start date, formatted as YYYY-MM-DD",
    parseDateOnly,
  )
  .requiredOption(
    "--to <date>",
    "End date, formatted as YYYY-MM-DD",
    parseDateOnly,
  )
  .option("--limit <n>", "Maximum transactions to return", parseLimit, 100)
  .option("--json", "Print the raw banking response as JSON")
  .action(
    withErrorHandler(async (options: TransactionsOptions) => {
      await runBankingRequest(
        "Banking transactions loaded",
        "transactions",
        {
          accountId: options.accountId,
          from: options.from,
          to: options.to,
          limit: options.limit,
        },
        options,
      );
    }),
  );

export const zeroBankingCommand = new Command()
  .name("banking")
  .description("Use managed zero banking services")
  .addCommand(accountsCommand)
  .addCommand(balancesCommand)
  .addCommand(transactionsCommand)
  .addHelpText(
    "after",
    `
Examples:
  List accounts:      zero banking accounts --json
  Get balance:        zero banking balances --account-id <id> --json
  Get transactions:   zero banking transactions --account-id <id> --from 2026-01-01 --to 2026-01-31 --json

Notes:
  - Authenticates via ZERO_TOKEN (requires banking:read capability)
  - Finicity credentials and app tokens stay on the vm0 API server
  - Access is limited to accounts enabled for the current agent`,
  );
