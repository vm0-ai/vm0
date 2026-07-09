import chalk from "chalk";
import { Command } from "commander";
import type {
  MemorySearchMode,
  MemorySourceProvider,
} from "@vm0/api-contracts/contracts/zero-memory";

import { searchZeroMemory } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { printMemorySearch } from "./format";

interface SearchOptions {
  readonly json?: boolean;
  readonly limit?: string;
  readonly mode?: string;
  readonly provider?: string;
}

const MEMORY_SEARCH_MODES = ["hybrid", "memories", "documents"] as const;
const MEMORY_PROVIDERS = ["gmail", "slack", "github", "notion"] as const;

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function parseMode(value: string | undefined): MemorySearchMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    MEMORY_SEARCH_MODES.some((mode) => {
      return mode === value;
    })
  ) {
    return value as MemorySearchMode;
  }
  console.error(chalk.red("✗ Unsupported memory search mode"));
  console.error(chalk.dim("  Use one of: hybrid, memories, documents"));
  process.exit(1);
}

function parseProvider(
  value: string | undefined,
): MemorySourceProvider | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    MEMORY_PROVIDERS.some((provider) => {
      return provider === value;
    })
  ) {
    return value as MemorySourceProvider;
  }
  console.error(chalk.red("✗ Unsupported memory provider"));
  console.error(chalk.dim("  Use one of: gmail, slack, github, notion"));
  process.exit(1);
}

export const searchCommand = new Command()
  .name("search")
  .description("Search structured memory and document chunks")
  .argument("<query>", "Search query")
  .option(
    "--mode <mode>",
    "Search mode: hybrid, memories, or documents",
    "hybrid",
  )
  .option("--provider <provider>", "Filter documents by source provider")
  .option("--limit <limit>", "Maximum results to return")
  .option("--json", "Print machine-readable JSON")
  .addHelpText(
    "after",
    `
Examples:
  Hybrid search:     zero memory search "security review"
  Documents only:    zero memory search "retention policy" --mode documents
  GitHub documents:  zero memory search "release plan" --provider github
  Print JSON:        zero memory search "Acme" --json

Notes:
  - Uses the authenticated user's active organization
  - Requires relationship memory to be enabled for the organization
  - This command is read-only`,
  )
  .action(
    withErrorHandler(async (query: string, options: SearchOptions) => {
      const response = await searchZeroMemory({
        q: query,
        mode: parseMode(options.mode),
        provider: parseProvider(options.provider),
        limit: parseLimit(options.limit),
      });

      if (options.json) {
        console.log(JSON.stringify(response));
        return;
      }

      printMemorySearch(response);
    }),
  );
