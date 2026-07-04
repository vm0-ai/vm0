import { Command } from "commander";

import { searchZeroRelationships } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { printRelationshipSearch } from "./format";

interface SearchOptions {
  readonly json?: boolean;
  readonly limit?: string;
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

export const searchCommand = new Command()
  .name("search")
  .description("Search relationship memory")
  .argument("<query>", "Search query")
  .option("--limit <limit>", "Maximum relationships to return")
  .option("--json", "Print machine-readable JSON")
  .addHelpText(
    "after",
    `
Examples:
  Search relationships:  zero relationship search "acme pricing"
  Print JSON:            zero relationship search "security review" --json

Notes:
  - Uses the authenticated user's active organization
  - Does not support cross-organization search
  - This command is read-only`,
  )
  .action(
    withErrorHandler(async (query: string, options: SearchOptions) => {
      const response = await searchZeroRelationships({
        q: query,
        limit: parseLimit(options.limit),
      });

      if (options.json) {
        console.log(JSON.stringify(response));
        return;
      }

      printRelationshipSearch(response.relationships);
    }),
  );
