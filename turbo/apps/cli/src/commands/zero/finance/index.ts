import { Command, InvalidArgumentError, Option } from "commander";
import chalk from "chalk";
import {
  ZERO_FINANCE_DEFAULT_INTERVAL,
  ZERO_FINANCE_DEFAULT_RANGE,
  zeroFinanceChartRequestSchema,
  zeroFinanceIntervalSchema,
  zeroFinanceProfileRequestSchema,
  zeroFinanceQuoteRequestSchema,
  zeroFinanceRangeSchema,
  zeroFinanceSearchRequestSchema,
  type ZeroFinanceInterval,
  type ZeroFinanceRange,
} from "@vm0/api-contracts/contracts/zero-finance";

import {
  callZeroFinanceChart,
  callZeroFinanceProfile,
  callZeroFinanceQuote,
  callZeroFinanceSearch,
  type ZeroFinanceResponse,
} from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

interface JsonOption {
  readonly json?: boolean;
}

interface ChartOptions extends JsonOption {
  readonly range: ZeroFinanceRange;
  readonly interval: ZeroFinanceInterval;
}

function firstIssueMessage(
  result:
    | ReturnType<typeof zeroFinanceSearchRequestSchema.safeParse>
    | ReturnType<typeof zeroFinanceProfileRequestSchema.safeParse>
    | ReturnType<typeof zeroFinanceQuoteRequestSchema.safeParse>
    | ReturnType<typeof zeroFinanceChartRequestSchema.safeParse>,
): string {
  return result.success
    ? "finance request is invalid"
    : (result.error.issues[0]?.message ?? "finance request is invalid");
}

function parseRange(value: string): ZeroFinanceRange {
  const result = zeroFinanceRangeSchema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  throw new InvalidArgumentError(
    `range must be one of: ${zeroFinanceRangeSchema.options.join(", ")}`,
  );
}

function parseInterval(value: string): ZeroFinanceInterval {
  const result = zeroFinanceIntervalSchema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  throw new InvalidArgumentError(
    `interval must be one of: ${zeroFinanceIntervalSchema.options.join(", ")}`,
  );
}

function renderResponse(response: ZeroFinanceResponse, json?: boolean): void {
  if (json) {
    console.log(JSON.stringify(response));
    return;
  }

  console.log(chalk.green(`✓ Finance ${response.operation} completed`));
  console.log(JSON.stringify(response.result, null, 2));
  console.log(chalk.dim(`Provider: ${response.provider}`));
  console.log(chalk.dim(`Credits charged: ${response.creditsCharged}`));
}

const searchCommand = new Command()
  .name("search")
  .description("Search for a financial instrument")
  .argument("<query>", "Company name, symbol, or instrument")
  .option("--json", "Print the raw Zero Finance response as JSON")
  .action(
    withErrorHandler(async (query: string, options: JsonOption) => {
      const request = zeroFinanceSearchRequestSchema.safeParse({ query });
      if (!request.success) {
        throw new InvalidArgumentError(firstIssueMessage(request));
      }
      renderResponse(await callZeroFinanceSearch(request.data), options.json);
    }),
  );

const profileCommand = new Command()
  .name("profile")
  .description("Fetch a company profile")
  .argument("<symbol>", "Yahoo Finance symbol, such as AAPL or 0700.HK")
  .option("--json", "Print the raw Zero Finance response as JSON")
  .action(
    withErrorHandler(async (symbol: string, options: JsonOption) => {
      const request = zeroFinanceProfileRequestSchema.safeParse({ symbol });
      if (!request.success) {
        throw new InvalidArgumentError(firstIssueMessage(request));
      }
      renderResponse(await callZeroFinanceProfile(request.data), options.json);
    }),
  );

const quoteCommand = new Command()
  .name("quote")
  .description("Fetch the latest available market quote")
  .argument("<symbol>", "Yahoo Finance symbol, such as AAPL or 0700.HK")
  .option("--json", "Print the raw Zero Finance response as JSON")
  .action(
    withErrorHandler(async (symbol: string, options: JsonOption) => {
      const request = zeroFinanceQuoteRequestSchema.safeParse({ symbol });
      if (!request.success) {
        throw new InvalidArgumentError(firstIssueMessage(request));
      }
      renderResponse(await callZeroFinanceQuote(request.data), options.json);
    }),
  );

const chartCommand = new Command()
  .name("chart")
  .description("Fetch OHLCV chart data")
  .argument("<symbol>", "Yahoo Finance symbol, such as AAPL or 0700.HK")
  .addOption(
    new Option("--range <range>", "Chart time range")
      .default(ZERO_FINANCE_DEFAULT_RANGE)
      .argParser(parseRange),
  )
  .addOption(
    new Option("--interval <interval>", "Chart interval")
      .default(ZERO_FINANCE_DEFAULT_INTERVAL)
      .argParser(parseInterval),
  )
  .option("--json", "Print the raw Zero Finance response as JSON")
  .action(
    withErrorHandler(async (symbol: string, options: ChartOptions) => {
      const request = zeroFinanceChartRequestSchema.safeParse({
        symbol,
        range: options.range,
        interval: options.interval,
      });
      if (!request.success) {
        throw new InvalidArgumentError(firstIssueMessage(request));
      }
      renderResponse(await callZeroFinanceChart(request.data), options.json);
    }),
  );

export const zeroFinanceCommand = new Command()
  .name("finance")
  .description("Query financial instruments through managed Zero Finance")
  .addCommand(searchCommand)
  .addCommand(profileCommand)
  .addCommand(quoteCommand)
  .addCommand(chartCommand)
  .addHelpText(
    "after",
    `
Examples:
  Search instruments:  zero finance search "Tencent"
  Company profile:     zero finance profile AAPL
  Latest quote:        zero finance quote 0700.HK --json
  Historical chart:   zero finance chart AAPL --range 1y --interval 1d

Notes:
  - Authenticates via ZERO_TOKEN (requires finance:read capability) or a CLI token
  - Each successful command consumes 1 credit
  - Data is returned from APIDojo's Yahoo Finance API on RapidAPI without Zero-side caching`,
  );
