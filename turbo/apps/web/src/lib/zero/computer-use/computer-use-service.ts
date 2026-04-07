/**
 * Computer-Use Host Service
 *
 * Orchestrates ngrok resource provisioning and host lifecycle
 * for computer-use remote desktop sessions.
 */
import { createHash, randomUUID } from "crypto";
import { eq, and, gt } from "drizzle-orm";
import { computerUseHosts } from "../../../db/schema/computer-use-host";
import { notFound } from "../../shared/errors";
import { logger } from "../../shared/logger";
import {
  findOrCreateBotUser,
  createCredential,
  deleteCredential,
  ensureCloudEndpoint,
  deleteCloudEndpoint,
  findOrCreateReservedDomain,
  deleteReservedDomain,
  deleteBotUser,
  safeDelete,
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

  const env = globalThis.services.env;
  const apiKey = env.NGROK_API_KEY;
  if (!apiKey) {
    throw new Error("NGROK_API_KEY is not configured");
  }

  // If existing host found, partially clean up (keep domain and bot user)
  const [existing] = await db
    .select()
    .from(computerUseHosts)
    .where(
      and(
        eq(computerUseHosts.orgId, orgId),
        eq(computerUseHosts.userId, userId),
      ),
    )
    .limit(1);

  let reusableDomain: { domain: string; id: string } | null = null;

  if (existing) {
    log.debug("Cleaning up existing host registration", { orgId, userId });

    // Delete credential and endpoint (need new token + routing), keep domain
    if (existing.ngrokCredentialId) {
      await safeDelete(
        () => {
          return deleteCredential(apiKey, existing.ngrokCredentialId!);
        },
        "Credential",
        existing.ngrokCredentialId,
      );
    }
    if (existing.ngrokEndpointId) {
      await safeDelete(
        () => {
          return deleteCloudEndpoint(apiKey, existing.ngrokEndpointId!);
        },
        "Cloud endpoint",
        existing.ngrokEndpointId,
      );
    }

    // Preserve domain for reuse (same user = same deterministic slug)
    if (existing.ngrokDomainId && existing.domain) {
      reusableDomain = { domain: existing.domain, id: existing.ngrokDomainId };
    }

    await db
      .delete(computerUseHosts)
      .where(eq(computerUseHosts.id, existing.id));
  }

  // Generate a DNS-safe slug from orgId+userId hash (hex chars only)
  const slug = createHash("sha256")
    .update(`${orgId}:${userId}`)
    .digest("hex")
    .substring(0, 12);
  const subdomainName = `vm0-cu-${slug}`;
  const endpointPrefix = `vm0-cu-${slug}`;
  const botUserName = `vm0-cu-${slug}`;

  // Provision ngrok resources — clean up on partial failure
  let botUserId: string | undefined;
  let credentialId: string | undefined;
  let domainId: string | undefined;
  let endpointId: string | undefined;

  try {
    const botUser = await findOrCreateBotUser(apiKey, botUserName);
    botUserId = botUser.id;

    const credential = await createCredential(apiKey, botUser.id, [
      `bind:*.${endpointPrefix}.internal`,
    ]);
    credentialId = credential.id;

    // Reuse existing domain or create new one
    let domain: string;
    if (reusableDomain) {
      domain = reusableDomain.domain;
      domainId = reusableDomain.id;
      log.debug("Reusing existing reserved domain", { domain, domainId });
    } else {
      const reservedDomain = await findOrCreateReservedDomain(
        apiKey,
        subdomainName,
        "us",
      );
      domain = reservedDomain.domain;
      domainId = reservedDomain.id;
    }

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
    const cloudEndpoint = await ensureCloudEndpoint(
      apiKey,
      endpointUrl,
      trafficPolicy,
    );
    endpointId = cloudEndpoint.id;

    // Create host row
    const [hostRow] = await db
      .insert(computerUseHosts)
      .values({
        orgId,
        userId,
        domain,
        token: bridgeToken,
        ngrokBotUserId: botUserId,
        ngrokCredentialId: credentialId,
        ngrokEndpointId: cloudEndpoint.id,
        ngrokDomainId: domainId,
        expiresAt: new Date(Date.now() + HOST_TTL_MS),
      })
      .returning();

    if (!hostRow) {
      throw new Error("Failed to create computer-use host");
    }

    log.debug("Computer-use host registered", {
      hostId: hostRow.id,
      botUserId,
      domain,
    });

    return {
      id: hostRow.id,
      domain,
      token: bridgeToken,
      ngrokToken: credential.token,
      endpointPrefix,
    };
  } catch (error) {
    log.error("Failed to register host, cleaning up", { orgId, userId });
    const eid = endpointId;
    const cid = credentialId;
    const did = domainId;
    const bid = botUserId;
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
    if (did && !reusableDomain) {
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
    throw error;
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
      await safeDelete(
        () => {
          return deleteCredential(apiKey, host.ngrokCredentialId!);
        },
        "Credential",
        host.ngrokCredentialId,
      );
    }

    if (host.ngrokEndpointId) {
      await safeDelete(
        () => {
          return deleteCloudEndpoint(apiKey, host.ngrokEndpointId!);
        },
        "Cloud endpoint",
        host.ngrokEndpointId,
      );
    }

    if (host.ngrokDomainId) {
      await safeDelete(
        () => {
          return deleteReservedDomain(apiKey, host.ngrokDomainId!);
        },
        "Reserved domain",
        host.ngrokDomainId,
      );
    }

    if (host.ngrokBotUserId) {
      await safeDelete(
        () => {
          return deleteBotUser(apiKey, host.ngrokBotUserId!);
        },
        "Bot user",
        host.ngrokBotUserId,
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
