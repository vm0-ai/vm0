import { readFile } from "node:fs/promises";

import chalk from "chalk";
import { Command } from "commander";

import { updateZeroCustomConnector } from "../../../../lib/api/domains/zero-connectors";
import { decodeZeroTokenPayload } from "../../../../lib/api/zero-token";
import { withErrorHandler } from "../../../../lib/command/with-error-handler";
import { updateCustomConnectorDefinitionFileSchema } from "./definition";

interface UpdateOptions {
  readonly file: string;
  readonly json?: boolean;
}

function requireCustomConnectorWriteCapability(): void {
  const payload = decodeZeroTokenPayload();
  if (payload && !payload.capabilities.includes("connector:write")) {
    throw new Error(
      "Custom connector update is not enabled for this agent run",
    );
  }
}

export const updateCustomConnectorCommand = new Command()
  .name("update")
  .description("Update a custom connector definition from JSON")
  .argument("<connector-id>", "Custom connector id")
  .requiredOption("-f, --file <path>", "JSON connector definition file")
  .option("--json", "Print the updated connector as JSON")
  .addHelpText(
    "after",
    `
The file uses the same complete HTTP or MCP definition shape as create.
OAuth updates may omit oauthConfig.clientSecret to preserve the encrypted
current client secret. Never include an end-user token or values array.

Examples:
  okou connector custom update <connector-id> --file ./connector.json
  okou connector custom update <connector-id> --file ./connector.json --json`,
  )
  .action(
    withErrorHandler(async (connectorId: string, options: UpdateOptions) => {
      requireCustomConnectorWriteCapability();
      const raw = await readFile(options.file, "utf8");
      const input: unknown = JSON.parse(raw);
      const definition = updateCustomConnectorDefinitionFileSchema.parse(input);
      const connector = await updateZeroCustomConnector(
        connectorId,
        definition,
      );
      if (options.json) {
        console.log(JSON.stringify(connector, null, 2));
        return;
      }
      console.log(
        chalk.green(`✓ Custom connector "${connector.displayName}" updated`),
      );
      console.log(chalk.dim(`  ID:   ${connector.id}`));
      console.log(chalk.dim(`  Kind: ${connector.kind}`));
    }),
  );
