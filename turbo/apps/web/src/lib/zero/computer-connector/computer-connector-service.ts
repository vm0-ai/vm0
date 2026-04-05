/**
 * Computer Connector Service
 *
 * Orchestrates ngrok resource provisioning and connector lifecycle
 * for authenticated local tunneling.
 */
import { createHash, randomUUID } from "crypto";
import { eq, and } from "drizzle-orm";
import type { ComputerConnectorCreateResponse } from "@vm0/core";
import { connectors } from "../../../db/schema/connector";
import { secrets } from "../../../db/schema/secret";
import { decryptSecretValue } from "../../shared/crypto";
import { badRequest, conflict, notFound } from "../../shared/errors";
import { logger } from "../../shared/logger";
import { upsertSecretByOrg } from "../secret/secret-service";
import {
  findOrCreateBotUser,
  createCredential,
  deleteCredential,
  createCloudEndpoint,
  deleteCloudEndpoint,
  findOrCreateReservedDomain,
  deleteReservedDomain,
  deleteBotUser,
  safeDelete,
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

  // Generate a DNS-safe slug from orgId hash (hex chars only)
  const slug = createHash("sha256")
    .update(orgId)
    .digest("hex")
    .substring(0, 12);
  const subdomainName = `vm0-user-${slug}`;
  const endpointPrefix = `vm0-user-${slug}`;

  const botUserName = `vm0-user-${slug}`;

  // Provision ngrok resources — clean up on partial failure
  let botUserId: string | undefined;
  let credentialId: string | undefined;
  let domainId: string | undefined;
  let endpointId: string | undefined;
  let connectorRowId: string | undefined;

  try {
    const botUser = await findOrCreateBotUser(apiKey, botUserName);
    botUserId = botUser.id;

    const credential = await createCredential(apiKey, botUser.id, [
      `bind:*.${endpointPrefix}.internal`,
    ]);
    credentialId = credential.id;

    const reservedDomain = await findOrCreateReservedDomain(
      apiKey,
      subdomainName,
      "us",
    );
    const domain = reservedDomain.domain; // e.g., "vm0-user-abc12345.ngrok-free.app"
    domainId = reservedDomain.id;

    const bridgeToken = randomUUID();

    // Traffic policy: verify bridge token and forward to internal endpoint
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

    const endpointUrl = `https://*.${domain}`;
    const cloudEndpoint = await createCloudEndpoint(
      apiKey,
      endpointUrl,
      trafficPolicy,
    );
    endpointId = cloudEndpoint.id;

    // Create connector row
    const db = globalThis.services.db;
    const [connectorRow] = await db
      .insert(connectors)
      .values({
        userId,
        orgId,
        type: "computer",
        authMethod: "api",
        externalId: botUserId,
        externalUsername: credentialId,
        externalEmail: cloudEndpoint.id,
        oauthScopes: null,
      })
      .returning();

    if (!connectorRow) {
      throw new Error("Failed to create connector");
    }
    connectorRowId = connectorRow.id;

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
        domainId,
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
      botUserId,
      domain,
    });

    return {
      id: connectorRow.id,
      ngrokToken: credential.token,
      bridgeToken,
      endpointPrefix,
      domain,
    };
  } catch (error) {
    // Clean up any resources created before the failure (best-effort to avoid masking original error)
    log.error("Failed to create computer connector, cleaning up", { orgId });
    const eid = endpointId;
    const cid = credentialId;
    const did = domainId;
    const bid = botUserId;
    const rid = connectorRowId;
    if (eid) {
      await safeDelete(
        () => {
          return deleteCloudEndpoint(apiKey, eid);
        },
        "Cloud endpoint",
        eid,
        true,
      );
    }
    if (cid) {
      await safeDelete(
        () => {
          return deleteCredential(apiKey, cid);
        },
        "Credential",
        cid,
        true,
      );
    }
    if (did) {
      await safeDelete(
        () => {
          return deleteReservedDomain(apiKey, did);
        },
        "Reserved domain",
        did,
        true,
      );
    }
    if (bid) {
      await safeDelete(
        () => {
          return deleteBotUser(apiKey, bid);
        },
        "Bot user",
        bid,
        true,
      );
    }
    if (rid) {
      const db = globalThis.services.db;
      await db
        .delete(connectors)
        .where(eq(connectors.id, rid))
        .catch(() => {});
    }
    throw error;
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
      externalId: connectors.externalId,
      externalUsername: connectors.externalUsername,
      externalEmail: connectors.externalEmail,
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
    await safeDelete(
      () => {
        return deleteCredential(apiKey, connector.externalUsername!);
      },
      "Credential",
      connector.externalUsername,
    );
  }

  if (apiKey && connector.externalEmail) {
    await safeDelete(
      () => {
        return deleteCloudEndpoint(apiKey, connector.externalEmail!);
      },
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

      await safeDelete(
        () => {
          return deleteReservedDomain(apiKey, domainId);
        },
        "Reserved domain",
        domainId,
      );
    }

    // Delete Bot User last (other resources depend on it)
    if (connector.externalId) {
      await safeDelete(
        () => {
          return deleteBotUser(apiKey, connector.externalId!);
        },
        "Bot user",
        connector.externalId,
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
