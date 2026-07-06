import chalk from "chalk";
import { Command } from "commander";

import { resolveZeroRelationship } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { printRelationship } from "./format";

interface GetOptions {
  readonly id?: string;
  readonly email?: string;
  readonly domain?: string;
  readonly json?: boolean;
}

function selectedLookupCount(options: GetOptions): number {
  return [options.id, options.email, options.domain].filter((value) => {
    return Boolean(value);
  }).length;
}

function printUsageError(message: string, hint: string): never {
  console.error(chalk.red(`✗ ${message}`));
  console.error(chalk.dim(`  ${hint}`));
  process.exit(1);
}

export const getCommand = new Command()
  .name("get")
  .description("Resolve a relationship by id, email, or domain")
  .option("--id <id>", "Resolve by relationship id")
  .option("--email <email>", "Resolve by primary email")
  .option("--domain <domain>", "Resolve by domain")
  .option("--json", "Print machine-readable JSON")
  .addHelpText(
    "after",
    `
Examples:
  Resolve by email:   zero relationship get --email alice@acme.com
  Resolve by domain:  zero relationship get --domain acme.com
  Resolve by id:      zero relationship get --id <relationship-id>
  Print JSON:         zero relationship get --email alice@acme.com --json

Notes:
  - Uses the authenticated user's active organization
  - Does not support cross-organization lookup
  - This command is read-only`,
  )
  .action(
    withErrorHandler(async (options: GetOptions) => {
      if (selectedLookupCount(options) !== 1) {
        printUsageError(
          "Choose exactly one lookup",
          "Pass one of --id, --email, or --domain.",
        );
      }

      const response = await resolveZeroRelationship(
        options.id
          ? { id: options.id }
          : options.email
            ? { email: options.email }
            : { domain: options.domain! },
      );

      if (options.json) {
        console.log(JSON.stringify(response));
        return;
      }

      if (!response.relationship) {
        console.log("No relationship found");
        return;
      }

      printRelationship(response.relationship);
    }),
  );
