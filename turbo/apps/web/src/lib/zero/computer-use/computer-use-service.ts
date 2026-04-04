/**
 * Computer-Use Host Service
 *
 * Orchestrates ngrok resource provisioning and host lifecycle
 * for computer-use remote desktop sessions.
 */
import { createHash, randomUUID } from "crypto";
import { eq, and, gt } from "drizzle-orm";
import { computerUseHosts } from "../../../db/schema/computer-use-host";
import { conflict, notFound } from "../../shared/errors";
import { logger } from "../../shared/logger";
import {
  findOrCreateBotUser,
  createCredential,
  deleteCredential,
  createCloudEndpoint,
  deleteCloudEndpoint,
  createReservedDomain,
  deleteReservedDomain,
} from "../computer-connector/ngrok-client";

const log = logger("service:computer-use");

/** Default TTL for a host registration: 1 hour */
const HOST_TTL_MS = 60 * 60 * 1000;

interface RegisterHostResult {
  id: string;
  domain: string;
  token: string;
  ngrokToken: string;
  endpointPrefix: string;
}

/**
 * Register a computer-use host.
 *
 * Provisions ngrok resources (Bot User, Credential, Reserved Domain,
 * Cloud Endpoint) and creates a DB row for the host session.
 */
export async function registerHost(
  orgId: string,
  userId: string,
): Promise<RegisterHostResult> {
  const db = globalThis.services.db;

  // Check for existing host
  const [existing] = await db
    .select({ id: computerUseHosts.id })
    .from(computerUseHosts)
    .where(
      and(
        eq(computerUseHosts.orgId, orgId),
        eq(computerUseHosts.userId, userId),
      ),
    )
    .limit(1);

  if (existing) {
    throw conflict("Computer-use host already registered");
  }

  const env = globalThis.services.env;
  const apiKey = env.NGROK_API_KEY;
  if (!apiKey) {
    throw new Error("NGROK_API_KEY is not configured");
  }

  // Generate a DNS-safe slug from orgId+userId hash (hex chars only)
  const slug = createHash("sha256")
    .update(`${orgId}:${userId}`)
    .digest("hex")
    .substring(0, 12);
  const subdomainName = `vm0-cu-${slug}`;
  const endpointPrefix = `vm0-cu-${slug}`;
  const botUserName = `vm0-cu-${slug}`;

  // Provision ngrok resources
  const botUser = await findOrCreateBotUser(apiKey, botUserName);
  const credential = await createCredential(apiKey, botUser.id, [
    `bind:*.${endpointPrefix}.internal`,
  ]);

  const reservedDomain = await createReservedDomain(
    apiKey,
    subdomainName,
    "us",
  );
  const domain = reservedDomain.domain;

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
            config: { status_code: 502, body: "Host offline" },
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

  // Create host row
  const [hostRow] = await db
    .insert(computerUseHosts)
    .values({
      orgId,
      userId,
      domain,
      token: bridgeToken,
      ngrokBotUserId: botUser.id,
      ngrokCredentialId: credential.id,
      ngrokEndpointId: cloudEndpoint.id,
      ngrokDomainId: reservedDomain.id,
      expiresAt: new Date(Date.now() + HOST_TTL_MS),
    })
    .returning();

  if (!hostRow) {
    throw new Error("Failed to create computer-use host");
  }

  log.debug("Computer-use host registered", {
    hostId: hostRow.id,
    botUserId: botUser.id,
    domain,
  });

  return {
    id: hostRow.id,
    domain,
    token: bridgeToken,
    ngrokToken: credential.token,
    endpointPrefix,
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
 * Unregister a computer-use host and clean up ngrok resources.
 */
export async function unregisterHost(
  orgId: string,
  userId: string,
): Promise<void> {
  const db = globalThis.services.db;

  const [host] = await db
    .select()
    .from(computerUseHosts)
    .where(
      and(
        eq(computerUseHosts.orgId, orgId),
        eq(computerUseHosts.userId, userId),
      ),
    )
    .limit(1);

  if (!host) {
    throw notFound("Computer-use host not found");
  }

  const apiKey = globalThis.services.env.NGROK_API_KEY;

  if (apiKey) {
    if (host.ngrokCredentialId) {
      await safeDeleteNgrokResource(
        () => {
          return deleteCredential(apiKey, host.ngrokCredentialId!);
        },
        "Credential",
        host.ngrokCredentialId,
      );
    }

    if (host.ngrokEndpointId) {
      await safeDeleteNgrokResource(
        () => {
          return deleteCloudEndpoint(apiKey, host.ngrokEndpointId!);
        },
        "Cloud endpoint",
        host.ngrokEndpointId,
      );
    }

    if (host.ngrokDomainId) {
      await safeDeleteNgrokResource(
        () => {
          return deleteReservedDomain(apiKey, host.ngrokDomainId!);
        },
        "Reserved domain",
        host.ngrokDomainId,
      );
    }
  }

  await db.delete(computerUseHosts).where(eq(computerUseHosts.id, host.id));

  log.debug("Computer-use host unregistered", { orgId });
}

/**
 * Get the active computer-use host for an org/user.
 * Returns null if no active (non-expired) host exists.
 */
export async function getHost(
  orgId: string,
  userId: string,
): Promise<{ domain: string; token: string } | null> {
  const [host] = await globalThis.services.db
    .select({
      domain: computerUseHosts.domain,
      token: computerUseHosts.token,
    })
    .from(computerUseHosts)
    .where(
      and(
        eq(computerUseHosts.orgId, orgId),
        eq(computerUseHosts.userId, userId),
        gt(computerUseHosts.expiresAt, new Date()),
      ),
    )
    .limit(1);

  return host ?? null;
}
