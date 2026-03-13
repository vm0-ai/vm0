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
import { decryptSecretValue } from "../crypto";
import { badRequest, conflict, notFound } from "../errors";
import { logger } from "../logger";
import { upsertSecretByOrg } from "../secret/secret-service";
import {
  findOrCreateBotUser,
  createCredential,
  deleteCredential,
  createCloudEndpoint,
  deleteCloudEndpoint,
  createReservedDomain,
  deleteReservedDomain,
} from "./ngrok-client";

const log = logger("service:computer-connector");

const COMPUTER_SECRETS = [
  "COMPUTER_CONNECTOR_BRIDGE_TOKEN",
  "COMPUTER_CONNECTOR_DOMAIN_ID",
  "COMPUTER_CONNECTOR_DOMAIN",
] as const;

/**
 * Create a computer connector with ngrok tunnel credentials.
 *
 * Provisions a ngrok Bot User + Credential, then stores the connector
 * and its 4 secrets (AUTHTOKEN, TOKEN, ENDPOINT, DOMAIN).
 */
export async function createComputerConnector(
  orgId: string,
  userId: string,
): Promise<ComputerConnectorCreateResponse> {
  // Check for existing connector
  const [existing] = await globalThis.services.db
    .select({ id: connectors.id })
    .from(connectors)
    .where(and(eq(connectors.orgId, orgId), eq(connectors.type, "computer")))
    .limit(1);

  if (existing) {
    throw conflict("Computer connector already exists");
  }

  const env = globalThis.services.env;
  const apiKey = env.NGROK_API_KEY;
  if (!apiKey) {
    throw badRequest("NGROK_API_KEY is not configured");
  }

  // Generate unique subdomain name for this user
  // Truncate org ID to keep subdomain short (ngrok has length limits)
  const orgIdShort = orgId.substring(0, 8);
  const subdomainName = `vm0-user-${orgIdShort}`;
  const endpointPrefix = `vm0-user-${orgId}`;

  const botUserName = `vm0-user-${orgId}`;

  // Provision ngrok resources
  const botUser = await findOrCreateBotUser(apiKey, botUserName);
  const credential = await createCredential(apiKey, botUser.id, [
    `bind:*.${endpointPrefix}.internal`,
  ]);

  // Create reserved domain - ngrok will assign: {subdomainName}.ngrok-free.app
  const reservedDomain = await createReservedDomain(
    apiKey,
    subdomainName,
    "us",
  );
  const domain = reservedDomain.domain; // e.g., "vm0-user-abc12345.ngrok-free.app"

  const bridgeToken = randomUUID();

  // Create Cloud Endpoint with traffic policy
  // Create traffic policy to verify bridge token and forward to internal endpoint
  // Domain format: *.vm0-user-abc12345.ngrok-free.app
  // Service URLs: test.vm0-user-abc12345.ngrok-free.app, api.vm0-user-abc12345.ngrok-free.app, etc.
  const trafficPolicy = JSON.stringify({
    on_http_request: [
      {
        // Deny if no x-vm0-token or token doesn't match
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
              // Extract service name from subdomain
              // e.g., test.vm0-user-abc12345.ngrok-free.app → test.vm0-user-{orgId}.internal
              // The full endpointPrefix (vm0-user-{orgId}) is used for ACL matching
              url: `https://$\{conn.server_name.split('.${domain}')[0]}.${endpointPrefix}.internal`,
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

  // Create cloud endpoint with wildcard subdomain
  // Format: https://*.vm0-user-abc12345.ngrok-free.app
  const endpointUrl = `https://*.${domain}`;
  const cloudEndpoint = await createCloudEndpoint(
    apiKey,
    endpointUrl,
    trafficPolicy,
  );

  // Create connector row
  // Store ngrok resource IDs:
  // - externalId: Bot User ID
  // - externalUsername: Credential ID
  // - externalEmail: Cloud Endpoint ID
  // - oauthScopes: null (not used for computer connector)
  const db = globalThis.services.db;
  const [connectorRow] = await db
    .insert(connectors)
    .values({
      userId,
      orgId,
      type: "computer",
      authMethod: "api",
      externalId: botUser.id,
      externalUsername: credential.id,
      externalEmail: cloudEndpoint.id,
      oauthScopes: null,
    })
    .returning();

  if (!connectorRow) {
    throw new Error("Failed to create connector");
  }

  // Store secrets (ngrok token is one-time use, returned to client only)
  await Promise.all([
    upsertSecretByOrg(
      orgId,
      userId,
      "COMPUTER_CONNECTOR_BRIDGE_TOKEN",
      bridgeToken,
      "connector",
      "Computer connector: COMPUTER_CONNECTOR_BRIDGE_TOKEN",
    ),
    upsertSecretByOrg(
      orgId,
      userId,
      "COMPUTER_CONNECTOR_DOMAIN_ID",
      reservedDomain.id,
      "connector",
      "Computer connector: COMPUTER_CONNECTOR_DOMAIN_ID",
    ),
    upsertSecretByOrg(
      orgId,
      userId,
      "COMPUTER_CONNECTOR_DOMAIN",
      domain,
      "connector",
      "Computer connector: COMPUTER_CONNECTOR_DOMAIN",
    ),
  ]);

  log.debug("Computer connector created", {
    connectorId: connectorRow.id,
    botUserId: botUser.id,
    domain,
  });

  return {
    id: connectorRow.id,
    ngrokToken: credential.token,
    bridgeToken,
    endpointPrefix,
    domain,
  };
}

/**
 * Helper to safely delete ngrok resource, ignoring 404 errors.
 */
async function safeDeleteNgrokResource(
  deleteFn: () => Promise<void>,
  resourceName: string,
  resourceId: string,
): Promise<void> {
  try {
    await deleteFn();
  } catch (error) {
    if (error instanceof Error && error.message.includes("404")) {
      log.debug(`${resourceName} already deleted`, { id: resourceId });
    } else {
      throw error;
    }
  }
}

/**
 * Delete the computer connector and revoke ngrok credentials.
 */
export async function deleteComputerConnector(
  orgId: string,
  userId: string,
): Promise<void> {
  const db = globalThis.services.db;

  const [connector] = await db
    .select({
      id: connectors.id,
      externalUsername: connectors.externalUsername,
      externalEmail: connectors.externalEmail,
      oauthScopes: connectors.oauthScopes,
    })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, orgId),
        eq(connectors.userId, userId),
        eq(connectors.type, "computer"),
      ),
    )
    .limit(1);

  if (!connector) {
    throw notFound("Computer connector not found");
  }

  const apiKey = globalThis.services.env.NGROK_API_KEY;

  // Delete ngrok resources (ignore 404 errors if already deleted)
  if (apiKey && connector.externalUsername) {
    await safeDeleteNgrokResource(
      () => deleteCredential(apiKey, connector.externalUsername!),
      "Credential",
      connector.externalUsername,
    );
  }

  if (apiKey && connector.externalEmail) {
    await safeDeleteNgrokResource(
      () => deleteCloudEndpoint(apiKey, connector.externalEmail!),
      "Cloud endpoint",
      connector.externalEmail,
    );
  }

  // Get domain ID from secrets to delete reserved domain
  if (apiKey) {
    const domainIdSecret = await db
      .select({ encryptedValue: secrets.encryptedValue })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, orgId),
          eq(secrets.userId, userId),
          eq(secrets.name, "COMPUTER_CONNECTOR_DOMAIN_ID"),
          eq(secrets.type, "connector"),
        ),
      )
      .limit(1);

    if (domainIdSecret[0]) {
      const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;
      const domainId = decryptSecretValue(
        domainIdSecret[0].encryptedValue,
        encryptionKey,
      );

      await safeDeleteNgrokResource(
        () => deleteReservedDomain(apiKey, domainId),
        "Reserved domain",
        domainId,
      );
    }
  }

  // Delete connector row
  await db.delete(connectors).where(eq(connectors.id, connector.id));

  // Delete all computer connector secrets
  for (const secretName of COMPUTER_SECRETS) {
    await db
      .delete(secrets)
      .where(
        and(
          eq(secrets.orgId, orgId),
          eq(secrets.userId, userId),
          eq(secrets.name, secretName),
          eq(secrets.type, "connector"),
        ),
      );
  }

  log.debug("Computer connector deleted", { orgId });
}
