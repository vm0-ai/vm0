import {
  ZERO_PEOPLE_SEARCH_DEFAULT_LIMIT,
  ZERO_PEOPLE_SEARCH_MAX_LIMIT,
  zeroPeopleSearchRequestSchema,
} from "@vm0/api-contracts/contracts/zero-people-search";
import chalk from "chalk";
import { Command, InvalidArgumentError, Option } from "commander";

import {
  callZeroPeopleSearch,
  type ZeroPeopleSearchResponse,
} from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

interface PeopleSearchOptions {
  readonly limit: number;
  readonly json?: boolean;
}

function parseLimit(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError(
      `limit must be an integer from 1 to ${ZERO_PEOPLE_SEARCH_MAX_LIMIT}`,
    );
  }
  const limit = Number(value);
  if (limit < 1 || limit > ZERO_PEOPLE_SEARCH_MAX_LIMIT) {
    throw new InvalidArgumentError(
      `limit must be an integer from 1 to ${ZERO_PEOPLE_SEARCH_MAX_LIMIT}`,
    );
  }
  return limit;
}

function renderMetadata(response: ZeroPeopleSearchResponse): void {
  console.log(chalk.dim(`  Provider: ${response.provider}`));
  console.log(chalk.dim(`  Billing category: ${response.billingCategory}`));
  console.log(chalk.dim(`  Billing quantity: ${response.billingQuantity}`));
  console.log(chalk.dim(`  Credits charged: ${response.creditsCharged}`));
}

function renderProfile(
  profile: ZeroPeopleSearchResponse["profiles"][number],
  index: number,
): void {
  console.log(`${index + 1}. ${profile.name}`);
  if (profile.title) {
    console.log(`   Title: ${profile.title}`);
  }
  if (profile.company) {
    console.log(`   Company: ${profile.company}`);
  }
  if (profile.location) {
    console.log(`   Location: ${profile.location}`);
  }
  if (profile.summary) {
    console.log(`   ${profile.summary}`);
  }
  console.log("   Sources:");
  for (const [sourceIndex, source] of profile.sources.entries()) {
    console.log(
      `     ${sourceIndex + 1}. ${source.title || "(untitled source)"}`,
    );
    console.log(`        ${source.url}`);
  }
}

function renderProfiles(response: ZeroPeopleSearchResponse): void {
  if (response.profiles.length === 0) {
    console.log(
      chalk.dim(
        "No matching professionals found. Try a broader role, company, skill, or location query.",
      ),
    );
    return;
  }
  for (const [index, profile] of response.profiles.entries()) {
    renderProfile(profile, index);
  }
}

export const zeroPeopleSearchCommand = new Command()
  .name("people-search")
  .description("Find professionals through managed zero people search")
  .argument("<query>", "Professional research query")
  .addOption(
    new Option(
      "--limit <count>",
      `Maximum profiles (1-${ZERO_PEOPLE_SEARCH_MAX_LIMIT})`,
    )
      .default(ZERO_PEOPLE_SEARCH_DEFAULT_LIMIT)
      .argParser(parseLimit),
  )
  .option("--json", "Print the raw people-search response as JSON")
  .action(
    withErrorHandler(async (query: string, options: PeopleSearchOptions) => {
      const request = zeroPeopleSearchRequestSchema.safeParse({
        query,
        limit: options.limit,
      });
      if (!request.success) {
        throw new InvalidArgumentError(
          request.error.issues[0]?.message ??
            "people-search request is invalid",
        );
      }
      const response = await callZeroPeopleSearch(request.data);
      if (options.json) {
        console.log(JSON.stringify(response));
        return;
      }
      console.log(chalk.green("✓ People search completed"));
      renderMetadata(response);
      renderProfiles(response);
    }),
  )
  .addHelpText(
    "after",
    `
Examples:
  Find a professional: zero people-search "Who leads platform engineering at Notion?"
  Search by criteria: zero people-search "Fintech compliance leaders in New York" --limit 10
  Machine-readable:   zero people-search "Kubernetes platform engineers" --json

Notes:
  - Authenticates via ZERO_TOKEN (requires people-search:read capability) or a CLI token
  - Successful requests use managed credits, including searches with no matches
  - Queries are sent to vm0's managed Perplexity provider; never include secrets or private context
  - Profile fields are model-extracted from public professional sources and are not verified facts
  - Verify important claims using the provider-backed source URLs shown with each profile
  - Use only for legitimate professional research; never for harassment, doxxing, stalking, unauthorized background screening, or unlawful employment/privacy decisions
  - This command does not enrich email/phone data, message people, scrape profiles, or access authenticated LinkedIn`,
  );
