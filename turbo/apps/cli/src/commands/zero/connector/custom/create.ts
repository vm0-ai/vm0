import { readFile } from "node:fs/promises";

import {
  updateCustomConnectorBodySchema,
  type CustomConnectorResponse,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";
import chalk from "chalk";
import { Command } from "commander";

import { createZeroCustomConnector } from "../../../../lib/api/domains/zero-connectors";
import { decodeZeroTokenPayload } from "../../../../lib/api/zero-token";
import { withErrorHandler } from "../../../../lib/command/with-error-handler";
import {
  connectorActionUrl,
  printCallbackActionUrlExample,
} from "../action-url";
import { getPlatformOrigin } from "../../doctor/platform-url";

const customConnectorDefinitionSchema = updateCustomConnectorBodySchema
  .strict()
  .refine(
    (definition) => {
      return definition.authMode !== undefined;
    },
    { message: 'Custom connector authMode must be "manual" or "oauth"' },
  )
  .refine(
    (definition) => {
      if (definition.authMode !== "manual") {
        return true;
      }
      const field = definition.fields[0];
      return (
        definition.oauthConfig === undefined &&
        definition.fields.length === 1 &&
        field?.key === "secret" &&
        field.kind === "secret" &&
        field.required
      );
    },
    {
      message:
        'Manual definitions require exactly one required secret field with key "secret" and no oauthConfig',
    },
  )
  .refine(
    (definition) => {
      if (definition.authMode !== "oauth") {
        return true;
      }
      return (
        definition.fields.length === 0 &&
        definition.oauthConfig?.providerAdapter === "standard" &&
        definition.oauthConfig.clientSecret !== undefined
      );
    },
    {
      message:
        "OAuth definitions require empty fields and standard OAuth app configuration including clientSecret",
    },
  );

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

async function printCreateResult(
  connector: CustomConnectorResponse,
  json: boolean,
): Promise<void> {
  if (json) {
    console.log(JSON.stringify(connector, null, 2));
    return;
  }

  console.log(
    chalk.green(`✓ Custom connector "${connector.displayName}" created`),
  );
  console.log(chalk.dim(`  ID:             ${connector.id}`));
  console.log(chalk.dim(`  Slug:           ${connector.slug}`));
  console.log(chalk.dim(`  Authentication: ${connector.authMode ?? "manual"}`));
  console.log(chalk.dim("  Status:         awaiting connection"));
  console.log();
  const agentId = process.env.ZERO_AGENT_ID?.trim() || undefined;
  const origin = await getPlatformOrigin();
  const url = connectorActionUrl({
    origin,
    path: `/connectors/${connector.slug}/connect`,
    ...(agentId ? { agentId } : {}),
  });
  console.log(`Connect it at: [Connect ${connector.displayName}](${url})`);
  printCallbackActionUrlExample(url, agentId);
}

export const createCustomConnectorCommand = new Command()
  .name("create")
  .description("Create a manual or OAuth custom connector definition from JSON")
  .requiredOption("-f, --file <path>", "JSON connector definition file")
  .option("--json", "Print the created connector as JSON")
  .addHelpText(
    "after",
    `
Definition file:
  Describe only the connector metadata, Header/Query injection templates, and
  OAuth app configuration when applicable. Never include an API token,
  end-user OAuth token, or values array. Creating the definition is separate
  from connecting it with a user's credential or OAuth grant.

Agent workflow:
  1. For manual connectors, ask only for missing metadata: name, HTTPS API
     prefix, and the Header or Query injection template. Do not ask the user
     for the actual API token.
  2. Convert placeholders such as <API Token> into {{secrets.secret}}. Manual
     definitions use exactly one required secret field whose key is "secret",
     matching the Connect dialog.
  3. For OAuth connectors, collect the same OAuth app configuration shown by
     the Connectors page, including the client ID and client secret. Never ask
     for an end-user access token or refresh token.
  4. Write a temporary JSON definition, run this command, then remove the file.
  5. Share the emitted Connect link so the user can finish the separate
     credential or OAuth flow when they are ready.

Manual API connector example:
  {
    "displayName": "Acme API",
    "prefixTemplates": ["https://api.acme.example/v1/"],
    "fields": [
      {
        "key": "secret",
        "label": "API Token",
        "kind": "secret",
        "required": true,
        "description": "API credential"
      }
    ],
    "headerInjections": [
      {
        "name": "Authorization",
        "valueTemplate": "Bearer {{secrets.secret}}"
      }
    ],
    "queryInjections": [],
    "authMode": "manual"
  }

OAuth connector example:
  {
    "displayName": "Acme OAuth API",
    "prefixTemplates": ["https://api.acme.example/v1/"],
    "fields": [],
    "headerInjections": [
      {
        "name": "Authorization",
        "valueTemplate": "Bearer {{oauth.access_token}}"
      }
    ],
    "queryInjections": [],
    "authMode": "oauth",
    "oauthConfig": {
      "providerAdapter": "standard",
      "clientId": "<oauth-client-id>",
      "clientSecret": "<oauth-client-secret>",
      "authorizationUrl": "https://acme.example/oauth/authorize",
      "tokenUrl": "https://acme.example/oauth/token",
      "tokenEndpointAuthMethod": "client_secret_post",
      "pkceMethod": "S256",
      "scopes": ["read", "write"],
      "authorizationParams": {}
    }
  }

Examples:
  zero connector custom create --file ./connector.json
  zero connector custom create --file ./connector.json --json

Notes:
  - This command only creates the connector definition; it does not store a
    manual API token, start OAuth authorization, or authorize an agent.
  - Manual credentials and end-user OAuth grants are supplied later through
    the Connect dialog.
  - OAuth app client secrets are definition-time configuration, matching UI
    creation, and should be kept in a temporary file that is never committed.
  - Requires an organization admin.`,
  )
  .action(
    withErrorHandler(async (options: CreateOptions) => {
      requireCustomConnectorWriteCapability();
      const raw = await readFile(options.file, "utf8");
      const input: unknown = JSON.parse(raw);
      const definition = customConnectorDefinitionSchema.parse(input);
      const connector = await createZeroCustomConnector(definition);
      await printCreateResult(connector, options.json ?? false);
    }),
  );
