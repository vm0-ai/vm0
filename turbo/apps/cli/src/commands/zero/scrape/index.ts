import { Command, InvalidArgumentError, Option } from "commander";
import chalk from "chalk";
import {
  zeroScrapeFormatSchema,
  zeroScrapeModeSchema,
  type ZeroScrapeResponse,
  type ZeroScrapeFormat,
  type ZeroScrapeMode,
} from "@vm0/api-contracts/contracts/zero-scrape";

import { callZeroScrape } from "../../../lib/api/domains/zero-scrape";
import { withErrorHandler } from "../../../lib/command/with-error-handler";

const SCRAPE_FORMATS = zeroScrapeFormatSchema.options;
const SCRAPE_MODES = zeroScrapeModeSchema.options;

interface ScrapeOptions {
  readonly format: ZeroScrapeFormat;
  readonly mode: ZeroScrapeMode;
  readonly json?: boolean;
}

function parseFormat(value: string): ZeroScrapeFormat {
  const result = zeroScrapeFormatSchema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  throw new InvalidArgumentError(
    `format must be one of: ${SCRAPE_FORMATS.join(", ")}`,
  );
}

function parseMode(value: string): ZeroScrapeMode {
  const result = zeroScrapeModeSchema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  throw new InvalidArgumentError(
    `mode must be one of: ${SCRAPE_MODES.join(", ")}`,
  );
}

function renderPdfPages(response: ZeroScrapeResponse): void {
  const numPages = response.metadata?.numPages;
  if (numPages === undefined) {
    return;
  }

  const totalPages = response.metadata?.totalPages;
  console.log(chalk.dim(`  Pages parsed: ${numPages}`));
  if (totalPages !== undefined && totalPages > numPages) {
    console.log(
      chalk.yellow(
        `  Truncated: parsed the first ${numPages} of ${totalPages} pages`,
      ),
    );
  }
}

function renderScrapeMetadata(response: ZeroScrapeResponse): void {
  console.log(chalk.dim(`  Provider: ${response.provider}`));
  console.log(chalk.dim(`  Billing category: ${response.billingCategory}`));
  console.log(chalk.dim(`  Billing quantity: ${response.billingQuantity}`));
  console.log(chalk.dim(`  Credits charged: ${response.creditsCharged}`));
  renderPdfPages(response);
}

function renderScrapeResult(response: ZeroScrapeResponse): void {
  if (response.format === "links") {
    for (const link of response.result.links) {
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
  Scrape a PDF:     zero scrape https://example.com/report.pdf --format markdown
  Enhanced scrape:  zero scrape https://example.com --mode enhanced --json

Notes:
  - Authenticates via ZERO_TOKEN (requires scrape:read capability) or a CLI token
  - Firecrawl calls and credit billing happen on the vm0 API server
  - Enhanced mode is explicit because it uses a higher billing category
  - PDF URLs are parsed into markdown, falling back to OCR for scanned pages
  - PDF scrapes bill one unit per parsed page and stop after 100 pages`,
  );
