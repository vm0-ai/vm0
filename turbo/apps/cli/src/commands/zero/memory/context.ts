import { Command } from "commander";

import { getZeroMemoryContext } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { printMemoryContext } from "./format";

interface ContextOptions {
  readonly json?: boolean;
  readonly limit?: string;
  readonly query?: string;
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

export const contextCommand = new Command()
  .name("context")
  .description("Print prompt-ready structured memory context")
  .option("--query <query>", "Optional query to focus the context")
  .option("--limit <limit>", "Maximum memories to include")
  .option("--json", "Print machine-readable JSON")
  .addHelpText(
    "after",
    `
Examples:
  General context:  zero memory context
  Focus context:    zero memory context --query "security review"
  Print JSON:       zero memory context --query "Acme" --json

Notes:
  - Uses the authenticated user's active organization
  - Requires relationship memory to be enabled for the organization
  - This command is read-only`,
  )
  .action(
    withErrorHandler(async (options: ContextOptions) => {
      const response = await getZeroMemoryContext({
        q: options.query,
        limit: parseLimit(options.limit),
      });

      if (options.json) {
        console.log(JSON.stringify(response));
        return;
      }

      printMemoryContext(response);
    }),
  );
