import chalk from "chalk";
import { Command } from "commander";
import type { MemoryRecallItemKind } from "@vm0/api-contracts/contracts/zero-memory";

import { recallZeroMemory } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { printMemoryRecall } from "./format";

interface RecallOptions {
  readonly json?: boolean;
  readonly kind?: string;
  readonly limit?: string;
}

const MEMORY_KINDS = ["key_fact", "preference", "open_loop"] as const;

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function parseKind(
  value: string | undefined,
): MemoryRecallItemKind | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    MEMORY_KINDS.some((kind) => {
      return kind === value;
    })
  ) {
    return value as MemoryRecallItemKind;
  }
  console.error(chalk.red("✗ Unsupported memory kind"));
  console.error(chalk.dim("  Use one of: key_fact, preference, open_loop"));
  process.exit(1);
}

export const recallCommand = new Command()
  .name("recall")
  .description("Recall structured memory by query")
  .argument("<query>", "Recall query")
  .option("--kind <kind>", "Filter by key_fact, preference, or open_loop")
  .option("--limit <limit>", "Maximum memories to return")
  .option("--json", "Print machine-readable JSON")
  .addHelpText(
    "after",
    `
Examples:
  Recall memory:  zero memory recall "security review"
  Filter kind:    zero memory recall "pricing" --kind open_loop
  Print JSON:     zero memory recall "Acme" --json

Notes:
  - Uses the authenticated user's active organization
  - Requires relationship memory to be enabled for the organization
  - This command is read-only`,
  )
  .action(
    withErrorHandler(async (query: string, options: RecallOptions) => {
      const response = await recallZeroMemory({
        q: query,
        kind: parseKind(options.kind),
        limit: parseLimit(options.limit),
      });

      if (options.json) {
        console.log(JSON.stringify(response));
        return;
      }

      printMemoryRecall(response.memories);
    }),
  );
