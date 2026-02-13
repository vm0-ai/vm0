/**
 * Computer Connector Service
 *
 * Orchestrates ngrok resource provisioning and connector lifecycle
 * for authenticated local tunneling.
 */
import { randomUUID } from "crypto";
import { eq, and } from "drizzle-orm";
import type { ComputerConnectorCreateResponse } from "@vm0/core";
import { connectors } from "../../db/schema/connector";
import { secrets } from "../../db/schema/secret";
import { encryptCredentialValue } from "../crypto";
import { badRequest, conflict, notFound } from "../errors";
import { logger } from "../logger";
import { getUserScopeByClerkId } from "../scope/scope-service";
import {
  findOrCreateBotUser,
  createCredential,
  deleteCredential,
  createCloudEndpoint,
  deleteCloudEndpoint,
} from "./ngrok-client";

const log = logger("service:computer-connector");

const COMPUTER_SECRETS = [
  "COMPUTER_CONNECTOR_AUTHTOKEN",
  "COMPUTER_CONNECTOR_TOKEN",
  "COMPUTER_CONNECTOR_ENDPOINT",
  "COMPUTER_CONNECTOR_DOMAIN",
] as const;

/**
 * Upsert a single connector secret (type="connector").
 */
async function upsertSecret(
  scopeId: string,
  name: string,
  value: string,
): Promise<void> {
  const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;
  const encryptedValue = encryptCredentialValue(value, encryptionKey);
  const db = globalThis.services.db;

  const [existing] = await db
    .select({ id: secrets.id })
    .from(secrets)
    .where(
      and(
        eq(secrets.scopeId, scopeId),
        eq(secrets.name, name),
        eq(secrets.type, "connector"),
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(secrets)
      .set({ encryptedValue, updatedAt: new Date() })
      .where(eq(secrets.id, existing.id));
  } else {
    await db.insert(secrets).values({
      scopeId,
      name,
      encryptedValue,
      type: "connector",
      description: `Computer connector: ${name}`,
    });
  }
}

/**
 * Create a computer connector with ngrok tunnel credentials.
 *
 * Provisions a ngrok Bot User + Credential, then stores the connector
 * and its 4 secrets (AUTHTOKEN, TOKEN, ENDPOINT, DOMAIN).
 */
export async function createComputerConnector(
  clerkUserId: string,
): Promise<ComputerConnectorCreateResponse> {
  const scope = await getUserScopeByClerkId(clerkUserId);
  if (!scope) {
    throw notFound("User scope not found");
  }

  // Check for existing connector
  const [existing] = await globalThis.services.db
    .select({ id: connectors.id })
    .from(connectors)
    .where(
      and(eq(connectors.scopeId, scope.id), eq(connectors.type, "computer")),
    )
    .limit(1);

  if (existing) {
    throw conflict("Computer connector already exists");
  }

  const env = globalThis.services.env;
  const apiKey = env.NGROK_API_KEY;
  if (!apiKey) {
    throw badRequest("NGROK_API_KEY is not configured");
  }

  const domain = env.NGROK_COMPUTER_CONNECTOR_DOMAIN;
  if (!domain) {
    throw badRequest("NGROK_COMPUTER_CONNECTOR_DOMAIN is not configured");
  }

  const botUserName = `vm0-user-${scope.id}`;
  const endpointPrefix = `vm0-user-${scope.id}`;

  // Provision ngrok resources
  const botUser = await findOrCreateBotUser(apiKey, botUserName);
  const credential = await createCredential(apiKey, botUser.id, [
    `bind:*.${endpointPrefix}.internal`,
  ]);

  const bridgeToken = randomUUID();

  // Create Cloud Endpoint with traffic policy
  const trafficPolicy = JSON.stringify({
    on_http_request: [
      {
        expressions: [
          `!('x-vm0-token' in req.headers) || req.headers['x-vm0-token'][0] != '${bridgeToken}'`,
        ],
        actions: [{ type: "deny", config: { status_code: 403 } }],
      },
      {
        actions: [
          {
            type: "forward-internal",
            config: {
              url: `https://$\{conn.server_name.split('.${domain}')[0]}.internal`,
              on_error: "continue",
            },
          },
          {
            type: "custom-response",
            config: { status_code: 502, body: "Agent offline" },
          },
        ],
      },
    ],
  });

  const endpointUrl = `https://*.${endpointPrefix}.${domain}`;
  const cloudEndpoint = await createCloudEndpoint(
    apiKey,
    endpointUrl,
    trafficPolicy,
  );

  // Create connector row
  const db = globalThis.services.db;
  const [connectorRow] = await db
    .insert(connectors)
    .values({
      scopeId: scope.id,
      type: "computer",
      authMethod: "api",
      externalId: botUser.id,
      externalUsername: credential.id,
      externalEmail: cloudEndpoint.id,
    })
    .returning();

  if (!connectorRow) {
    throw new Error("Failed to create connector");
  }

  // Store all 4 secrets
  await Promise.all([
    upsertSecret(scope.id, "COMPUTER_CONNECTOR_AUTHTOKEN", credential.token),
    upsertSecret(scope.id, "COMPUTER_CONNECTOR_TOKEN", bridgeToken),
    upsertSecret(scope.id, "COMPUTER_CONNECTOR_ENDPOINT", endpointPrefix),
    upsertSecret(scope.id, "COMPUTER_CONNECTOR_DOMAIN", domain),
  ]);

  log.debug("Computer connector created", {
    connectorId: connectorRow.id,
    botUserId: botUser.id,
  });

  return {
    id: connectorRow.id,
    authtoken: credential.token,
    bridgeToken,
    endpointPrefix,
    domain,
  };
}

/**
 * Delete the computer connector and revoke ngrok credentials.
 */
export async function deleteComputerConnector(
  clerkUserId: string,
): Promise<void> {
  const scope = await getUserScopeByClerkId(clerkUserId);
  if (!scope) {
    throw notFound("Computer connector not found");
  }

  const db = globalThis.services.db;

  const [connector] = await db
    .select({
      id: connectors.id,
      externalUsername: connectors.externalUsername,
      externalEmail: connectors.externalEmail,
    })
    .from(connectors)
    .where(
      and(eq(connectors.scopeId, scope.id), eq(connectors.type, "computer")),
    )
    .limit(1);

  if (!connector) {
    throw notFound("Computer connector not found");
  }

  // Revoke ngrok credential
  const apiKey = globalThis.services.env.NGROK_API_KEY;
  if (apiKey && connector.externalUsername) {
    await deleteCredential(apiKey, connector.externalUsername);
  }

  // Delete Cloud Endpoint
  if (apiKey && connector.externalEmail) {
    await deleteCloudEndpoint(apiKey, connector.externalEmail);
  }

  // Delete connector row
  await db.delete(connectors).where(eq(connectors.id, connector.id));

  // Delete all computer connector secrets
  for (const secretName of COMPUTER_SECRETS) {
    await db
      .delete(secrets)
      .where(
        and(
          eq(secrets.scopeId, scope.id),
          eq(secrets.name, secretName),
          eq(secrets.type, "connector"),
        ),
      );
  }

  log.debug("Computer connector deleted", { scopeId: scope.id });
}
