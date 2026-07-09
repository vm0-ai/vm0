import { Command, InvalidArgumentError, Option } from "commander";
import chalk from "chalk";
import { callZeroScrape, type ZeroScrapeResponse } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

const SCRAPE_FORMATS = ["markdown", "links"] as const;
const SCRAPE_MODES = ["standard", "enhanced"] as const;

type ScrapeFormat = (typeof SCRAPE_FORMATS)[number];
type ScrapeMode = (typeof SCRAPE_MODES)[number];

interface ScrapeOptions {
  readonly format: ScrapeFormat;
  readonly mode: ScrapeMode;
  readonly json?: boolean;
}

function parseFormat(value: string): ScrapeFormat {
  if (SCRAPE_FORMATS.includes(value as ScrapeFormat)) {
    return value as ScrapeFormat;
  }
  throw new InvalidArgumentError(
    `format must be one of: ${SCRAPE_FORMATS.join(", ")}`,
  );
}

function parseMode(value: string): ScrapeMode {
  if (SCRAPE_MODES.includes(value as ScrapeMode)) {
    return value as ScrapeMode;
  }
  throw new InvalidArgumentError(
    `mode must be one of: ${SCRAPE_MODES.join(", ")}`,
  );
}

function renderScrapeMetadata(response: ZeroScrapeResponse): void {
  console.log(chalk.dim(`  Provider: ${response.provider}`));
  console.log(chalk.dim(`  Billing category: ${response.billingCategory}`));
  console.log(chalk.dim(`  Billing quantity: ${response.billingQuantity}`));
  console.log(chalk.dim(`  Credits charged: ${response.creditsCharged}`));
}

function renderScrapeResult(response: ZeroScrapeResponse): void {
  if (response.format === "links") {
    for (const link of response.result.links ?? []) {
      console.log(link);
    }
    return;
  }

  const markdown = response.result.markdown;
  if (markdown) {
    console.log(markdown);
  }
}

export const zeroScrapeCommand = new Command()
  .name("scrape")
  .description("Scrape a public web page through managed zero scrape")
  .argument("<url>", "Public http or https URL to scrape")
  .addOption(
    new Option("--format <format>", "Output format")
      .default("markdown")
      .argParser(parseFormat),
  )
  .addOption(
    new Option("--mode <mode>", "Scrape mode")
      .default("standard")
      .argParser(parseMode),
  )
  .option("--json", "Print the raw scrape response as JSON")
  .action(
    withErrorHandler(async (url: string, options: ScrapeOptions) => {
      const response = await callZeroScrape({
        url,
        format: options.format,
        mode: options.mode,
      });

      if (options.json) {
        console.log(JSON.stringify(response));
        return;
      }

      console.log(chalk.green("✓ Scrape completed"));
      renderScrapeMetadata(response);
      renderScrapeResult(response);
    }),
  )
  .addHelpText(
    "after",
    `
Examples:
  Scrape markdown:  zero scrape https://example.com --format markdown
  Scrape links:     zero scrape https://example.com --format links
  Enhanced scrape:  zero scrape https://example.com --mode enhanced --json

Notes:
  - Authenticates via ZERO_TOKEN (requires scrape:read capability) or a CLI token
  - Firecrawl calls and credit billing happen on the vm0 API server
  - Enhanced mode is explicit because it uses a higher billing category`,
  );
