import { readFile } from "node:fs/promises";

import {
  customConnectorAuthModeSchema,
  updateCustomConnectorBodySchema,
  type CustomConnectorResponse,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";
import chalk from "chalk";
import { Command } from "commander";

import { createZeroCustomConnector } from "../../../../lib/api/domains/zero-connectors";
import { decodeZeroTokenPayload } from "../../../../lib/api/zero-token";
import { withErrorHandler } from "../../../../lib/command/with-error-handler";

const apiCustomConnectorDefinitionSchema = updateCustomConnectorBodySchema
  .omit({
    authMode: true,
    oauthConfig: true,
  })
  .extend({
    authMode: customConnectorAuthModeSchema.extract(["manual"]),
  })
  .strict();

interface CreateOptions {
  readonly file: string;
  readonly json?: boolean;
}

function requireCustomConnectorWriteCapability(): void {
  const payload = decodeZeroTokenPayload();
  if (payload && !payload.capabilities.includes("connector:write")) {
    throw new Error(
      "Custom connector creation is not enabled for this agent run",
    );
  }
}

function printCreateResult(
  connector: CustomConnectorResponse,
  json: boolean,
): void {
  if (json) {
    console.log(JSON.stringify(connector, null, 2));
    return;
  }

  console.log(
    chalk.green(`✓ Custom connector "${connector.displayName}" created`),
  );
  console.log(chalk.dim(`  ID:             ${connector.id}`));
  console.log(chalk.dim(`  Slug:           ${connector.slug}`));
  console.log(chalk.dim("  Status:         awaiting connection"));
  console.log();
  console.log(
    "Open the Connectors page to enter the credential before using this connector.",
  );
}

export const createCustomConnectorCommand = new Command()
  .name("create")
  .description("Create an API custom connector definition from JSON")
  .requiredOption("-f, --file <path>", "JSON connector definition file")
  .option("--json", "Print the created connector as JSON")
  .addHelpText(
    "after",
    `
Definition file:
  Describe only the connector metadata and credential injection template.
  Never include an API token, credential value, or values array. Creating the
  definition is separate from connecting it with a user's credential.

Agent workflow:
  1. Ask only for missing metadata: name, HTTPS API prefix, and the Header or
     Query injection template. Do not ask the user for the actual API token.
  2. Convert placeholders such as <API Token> into a secret field reference.
  3. Write a temporary JSON definition, run this command, then remove the file.
  4. Tell the user to connect it from the Connectors page when they are ready
     to enter the actual credential.

API connector example:
  {
    "displayName": "Acme API",
    "prefixTemplates": ["https://api.acme.example/v1/"],
    "fields": [
      {
        "key": "api_token",
        "label": "API Token",
        "kind": "secret",
        "required": true,
        "description": "API credential"
      }
    ],
    "headerInjections": [
      {
        "name": "Authorization",
        "valueTemplate": "Bearer {{secrets.api_token}}"
      }
    ],
    "queryInjections": [],
    "authMode": "manual"
  }

Template references:
  - Secret fields:   {{secrets.KEY}}
  - Variable fields: {{variables.KEY}}

Examples:
  zero connector custom create --file ./connector.json
  zero connector custom create --file ./connector.json --json

Notes:
  - This command creates API/manual connector definitions only.
  - OAuth custom connectors must be created from the Connectors page.
  - The user supplies the actual credential later through the Connect dialog.
  - Requires an organization admin and the customConnectorCliCreate feature.`,
  )
  .action(
    withErrorHandler(async (options: CreateOptions) => {
      requireCustomConnectorWriteCapability();
      const raw = await readFile(options.file, "utf8");
      const input: unknown = JSON.parse(raw);
      const definition = apiCustomConnectorDefinitionSchema.parse(input);
      const connector = await createZeroCustomConnector(definition);
      printCreateResult(connector, options.json ?? false);
    }),
  );
