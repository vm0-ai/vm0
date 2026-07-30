import { readFile } from "node:fs/promises";

import {
  customConnectorAuthModeSchema,
  customConnectorOAuthConfigInputSchema,
  customConnectorValueInputSchema,
  updateCustomConnectorBodySchema,
  type CustomConnectorResponse,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";
import chalk from "chalk";
import { Command } from "commander";

import {
  addZeroAgentCustomConnector,
  createZeroCustomConnector,
  getZeroAgent,
  setZeroCustomConnectorValues,
  startZeroCustomConnectorOAuth2,
} from "../../../../lib/api";
import { decodeZeroTokenPayload } from "../../../../lib/api/zero-token";
import { withErrorHandler } from "../../../../lib/command";

const customConnectorDefinitionSchema = updateCustomConnectorBodySchema.omit({
  authMode: true,
  oauthConfig: true,
});

const manualCustomConnectorCreateSchema = customConnectorDefinitionSchema
  .extend({
    authMode: customConnectorAuthModeSchema.extract(["manual"]),
    values: customConnectorValueInputSchema.array(),
  })
  .strict();

const oauthCreateConfigSchema = customConnectorOAuthConfigInputSchema.required({
  clientSecret: true,
});

const oauthCustomConnectorCreateSchema = customConnectorDefinitionSchema
  .extend({
    authMode: customConnectorAuthModeSchema.extract(["oauth"]),
    oauthConfig: oauthCreateConfigSchema,
    values: customConnectorValueInputSchema.array(),
  })
  .strict();

const customConnectorCreateSchema = manualCustomConnectorCreateSchema.or(
  oauthCustomConnectorCreateSchema,
);

type CustomConnectorCreateInput = ReturnType<
  typeof customConnectorCreateSchema.parse
>;

interface CreateOptions {
  readonly file: string;
  readonly agent?: string;
  readonly json?: boolean;
}

interface CreateResult {
  readonly connector: CustomConnectorResponse;
  readonly agentId?: string;
  readonly authorizationUrl?: string;
}

function requireCustomConnectorWriteCapability(): void {
  const payload = decodeZeroTokenPayload();
  if (payload && !payload.capabilities.includes("connector:write")) {
    throw new Error(
      "Custom connector creation is not enabled for this agent run",
    );
  }
}

function valueMarker(value: {
  readonly key: string;
  readonly kind: "secret" | "variable";
}): string {
  return `${value.kind}:${value.key}`;
}

function validateValues(definition: CustomConnectorCreateInput): void {
  const fields = new Map(
    definition.fields.map((field) => {
      return [valueMarker(field), field] as const;
    }),
  );
  const provided = new Set<string>();
  for (const value of definition.values) {
    const marker = valueMarker(value);
    if (!fields.has(marker)) {
      throw new Error(`Unknown custom connector value: ${marker}`);
    }
    if (provided.has(marker)) {
      throw new Error(`Duplicate custom connector value: ${marker}`);
    }
    provided.add(marker);
  }
  const missing = definition.fields.flatMap((field) => {
    const marker = valueMarker(field);
    return field.required && !provided.has(marker) ? [marker] : [];
  });
  if (missing.length > 0) {
    throw new Error(
      `Missing required custom connector values: ${missing.join(", ")}`,
    );
  }
}

function printCreateResult(result: CreateResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(
    chalk.green(`✓ Custom connector "${result.connector.displayName}" created`),
  );
  console.log(chalk.dim(`  ID:             ${result.connector.id}`));
  console.log(chalk.dim(`  Slug:           ${result.connector.slug}`));
  console.log(
    chalk.dim(`  Authentication: ${result.connector.authMode ?? "manual"}`),
  );
  console.log(
    chalk.dim(
      `  Status:         ${
        result.connector.connected ? "connected" : "awaiting authorization"
      }`,
    ),
  );
  if (result.agentId && !result.authorizationUrl) {
    console.log(chalk.dim(`  Agent:          ${result.agentId} (authorized)`));
  }
  if (!result.authorizationUrl) {
    return;
  }

  console.log();
  console.log("Complete OAuth authorization:");
  console.log(
    `  [Authorize ${result.connector.displayName}](${result.authorizationUrl})`,
  );
  if (result.agentId) {
    console.log(
      chalk.dim(
        `  Approval will also authorize this connector for agent ${result.agentId}.`,
      ),
    );
  }
}

async function createManualCustomConnector(
  definition: Extract<CustomConnectorCreateInput, { authMode: "manual" }>,
  agentId: string | undefined,
): Promise<CreateResult> {
  validateValues(definition);
  const { values, ...body } = definition;
  const created = await createZeroCustomConnector(body);
  const connector = await setZeroCustomConnectorValues(created.id, values);
  if (agentId) {
    await addZeroAgentCustomConnector(agentId, connector.id);
  }
  return {
    connector,
    ...(agentId ? { agentId } : {}),
  };
}

async function createOAuthCustomConnector(
  definition: Extract<CustomConnectorCreateInput, { authMode: "oauth" }>,
  agentId: string | undefined,
): Promise<CreateResult> {
  validateValues(definition);
  const { values, ...body } = definition;
  const created = await createZeroCustomConnector(body);
  const connector =
    values.length > 0
      ? await setZeroCustomConnectorValues(created.id, values)
      : created;
  const authorizationUrl = await startZeroCustomConnectorOAuth2(
    connector.id,
    agentId,
  );
  return {
    connector,
    authorizationUrl,
    ...(agentId ? { agentId } : {}),
  };
}

export const createCustomConnectorCommand = new Command()
  .name("create")
  .description(
    "Create and configure a manual or OAuth custom connector from JSON",
  )
  .requiredOption(
    "-f, --file <path>",
    "JSON file containing the connector definition and credentials",
  )
  .option(
    "--agent <id>",
    "Authorize this agent (defaults to ZERO_AGENT_ID when available)",
  )
  .option("--json", "Print the connector and authorization result as JSON")
  .addHelpText(
    "after",
    `
File format:
  The file must contain one complete connector definition. The agent should
  generate this file from the user's requirements and credentials.

Agent workflow:
  1. Ask the user in chat only for missing API details and credentials.
  2. Derive the prefixes, fields, injections, and OAuth settings.
  3. Write a temporary JSON file, run this command, then remove the file.
  The user should not need to write JSON or run this command.

  Common fields:
    displayName       Human-readable connector name
    prefixTemplates   Allowed HTTPS API URL prefixes
    fields            Inputs referenced by manual templates
    headerInjections  Headers added to matching requests
    queryInjections   Query parameters added to matching requests
    authMode          "manual" or "oauth"

Manual mode:
  Add a values array with one entry for every required field. References use
  {{secrets.KEY}} or {{variables.KEY}}. The command creates the connector,
  stores the values, and authorizes --agent in one flow.

  {
    "displayName": "Acme API",
    "prefixTemplates": ["https://api.acme.example/v1/"],
    "fields": [
      {
        "key": "api_key",
        "label": "API key",
        "kind": "secret",
        "required": true
      }
    ],
    "headerInjections": [
      {
        "name": "Authorization",
        "valueTemplate": "Bearer {{secrets.api_key}}"
      }
    ],
    "queryInjections": [],
    "authMode": "manual",
    "values": [
      { "key": "api_key", "kind": "secret", "value": "<user-api-key>" }
    ]
  }

OAuth mode:
  Use {{oauth.access_token}} in an injection and provide the complete OAuth
  client configuration. Add values for required non-OAuth fields such as a
  tenant subdomain. The command stores them and prints an authorization link.
  If --agent is set, completing OAuth also authorizes that agent.

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
    "values": [],
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
  zero connector custom create --file ./connector.json --agent <agent-id>
  zero connector custom create --file ./connector.json --json

Notes:
  - Requires an organization admin
  - Requires the customConnectorCliCreate feature
  - OAuth custom connectors also require the customConnectorOAuth2 feature
  - --agent defaults to ZERO_AGENT_ID inside an agent run
  - OAuth always requires the user to approve the generated authorization link
  - The file contains plaintext credentials; keep it temporary and never commit it`,
  )
  .action(
    withErrorHandler(async (options: CreateOptions) => {
      requireCustomConnectorWriteCapability();
      const raw = await readFile(options.file, "utf8");
      const input: unknown = JSON.parse(raw);
      const definition = customConnectorCreateSchema.parse(input);
      const agentId = options.agent ?? process.env.ZERO_AGENT_ID;
      if (agentId) {
        await getZeroAgent(agentId);
      }
      const result =
        definition.authMode === "manual"
          ? await createManualCustomConnector(definition, agentId)
          : await createOAuthCustomConnector(definition, agentId);
      printCreateResult(result, options.json ?? false);
    }),
  );
