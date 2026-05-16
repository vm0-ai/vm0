import { createHash, randomUUID } from "node:crypto";

import { command, computed, type Computed } from "ccstate";
import { computerUseHosts } from "@vm0/db/schema/computer-use-host";
import { and, eq, gt } from "drizzle-orm";

import { optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { db$, writeDb$, type Db } from "../external/db";
import {
  createCredential,
  deleteBotUser,
  deleteCloudEndpoint,
  deleteCredential,
  deleteReservedDomain,
  ensureCloudEndpoint,
  findOrCreateBotUser,
  findOrCreateReservedDomain,
  safeDelete,
} from "../external/ngrok-client";
import { settle } from "../utils";

const log = logger("service:computer-use");

/** Default TTL for a host registration: 1 hour */
const HOST_TTL_MS = 60 * 60 * 1000;

interface RegisterHostResult {
  readonly id: string;
  readonly domain: string;
  readonly token: string;
  readonly ngrokToken: string;
  readonly endpointPrefix: string;
}

type UnregisterHostResult =
  | { readonly kind: "ok" }
  | { readonly kind: "not_found" };

interface HostArgs {
  readonly orgId: string;
  readonly userId: string;
}

type ExistingHost = typeof computerUseHosts.$inferSelect;

interface ReusableDomain {
  readonly domain: string;
  readonly id: string;
}

interface ProvisionedRefs {
  readonly endpointId?: string;
  readonly credentialId?: string;
  readonly domainId?: string;
  readonly botUserId?: string;
}

export function zeroComputerUseHost(
  args: HostArgs,
): Computed<
  Promise<{ readonly domain: string; readonly token: string } | null>
> {
  return computed(
    async (
      get,
    ): Promise<{ readonly domain: string; readonly token: string } | null> => {
      const [host] = await get(db$)
        .select({
          domain: computerUseHosts.domain,
          token: computerUseHosts.token,
        })
        .from(computerUseHosts)
        .where(
          and(
            eq(computerUseHosts.orgId, args.orgId),
            eq(computerUseHosts.userId, args.userId),
            gt(computerUseHosts.expiresAt, nowDate()),
          ),
        )
        .limit(1);

      return host ?? null;
    },
  );
}

async function cleanupExistingHost(
  db: Db,
  existing: ExistingHost,
  apiKey: string,
): Promise<ReusableDomain | null> {
  log.debug("Cleaning up existing host registration", {
    orgId: existing.orgId,
    userId: existing.userId,
  });

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

  const reusableDomain: ReusableDomain | null =
    existing.ngrokDomainId && existing.domain
      ? { domain: existing.domain, id: existing.ngrokDomainId }
      : null;

  await db.delete(computerUseHosts).where(eq(computerUseHosts.id, existing.id));

  return reusableDomain;
}

async function rollbackNgrokResources(
  apiKey: string,
  refs: ProvisionedRefs,
  reusableDomain: ReusableDomain | null,
): Promise<void> {
  if (refs.endpointId) {
    const eid = refs.endpointId;
    await safeDelete(
      () => {
        return deleteCloudEndpoint(apiKey, eid);
      },
      "Cloud endpoint",
      eid,
      true,
    );
  }
  if (refs.credentialId) {
    const cid = refs.credentialId;
    await safeDelete(
      () => {
        return deleteCredential(apiKey, cid);
      },
      "Credential",
      cid,
      true,
    );
  }
  if (refs.domainId && !reusableDomain) {
    const did = refs.domainId;
    await safeDelete(
      () => {
        return deleteReservedDomain(apiKey, did);
      },
      "Reserved domain",
      did,
      true,
    );
  }
  if (refs.botUserId) {
    const bid = refs.botUserId;
    await safeDelete(
      () => {
        return deleteBotUser(apiKey, bid);
      },
      "Bot user",
      bid,
      true,
    );
  }
}

function buildTrafficPolicy(
  domain: string,
  endpointPrefix: string,
  bridgeToken: string,
): string {
  return JSON.stringify({
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
}

interface ProvisionContext {
  readonly db: Db;
  readonly args: HostArgs;
  readonly apiKey: string;
  readonly reusableDomain: ReusableDomain | null;
  readonly refs: { -readonly [K in keyof ProvisionedRefs]: ProvisionedRefs[K] };
}

async function provisionAndPersistHost(
  ctx: ProvisionContext,
  signal: AbortSignal,
): Promise<RegisterHostResult> {
  const { db, args, apiKey, reusableDomain, refs } = ctx;
  const slug = createHash("sha256")
    .update(`${args.orgId}:${args.userId}`)
    .digest("hex")
    .substring(0, 12);
  const subdomainName = `vm0-cu-${slug}`;
  const endpointPrefix = `vm0-cu-${slug}`;
  const botUserName = `vm0-cu-${slug}`;

  const botUser = await findOrCreateBotUser(apiKey, botUserName);
  signal.throwIfAborted();
  refs.botUserId = botUser.id;

  const credential = await createCredential(apiKey, botUser.id, [
    `bind:*.${endpointPrefix}.internal`,
  ]);
  signal.throwIfAborted();
  refs.credentialId = credential.id;

  let domain: string;
  if (reusableDomain) {
    domain = reusableDomain.domain;
    refs.domainId = reusableDomain.id;
    log.debug("Reusing existing reserved domain", {
      domain,
      domainId: refs.domainId,
    });
  } else {
    const reservedDomain = await findOrCreateReservedDomain(
      apiKey,
      subdomainName,
      "us",
    );
    signal.throwIfAborted();
    domain = reservedDomain.domain;
    refs.domainId = reservedDomain.id;
  }

  const bridgeToken = randomUUID();
  const trafficPolicy = buildTrafficPolicy(domain, endpointPrefix, bridgeToken);

  const cloudEndpoint = await ensureCloudEndpoint(
    apiKey,
    `https://*.${domain}`,
    trafficPolicy,
  );
  signal.throwIfAborted();
  refs.endpointId = cloudEndpoint.id;

  const [hostRow] = await db
    .insert(computerUseHosts)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      domain,
      token: bridgeToken,
      ngrokBotUserId: refs.botUserId,
      ngrokCredentialId: refs.credentialId,
      ngrokEndpointId: cloudEndpoint.id,
      ngrokDomainId: refs.domainId,
      expiresAt: new Date(nowDate().getTime() + HOST_TTL_MS),
    })
    .returning();
  signal.throwIfAborted();

  if (!hostRow) {
    throw new Error("Failed to create computer-use host");
  }

  log.debug("Computer-use host registered", {
    hostId: hostRow.id,
    botUserId: refs.botUserId,
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

export const registerHost$ = command(
  async (
    { set },
    args: HostArgs,
    signal: AbortSignal,
  ): Promise<RegisterHostResult> => {
    const apiKey = optionalEnv("NGROK_API_KEY");
    if (!apiKey) {
      throw new Error("NGROK_API_KEY is not configured");
    }

    const db = set(writeDb$);

    const [existing] = await db
      .select()
      .from(computerUseHosts)
      .where(
        and(
          eq(computerUseHosts.orgId, args.orgId),
          eq(computerUseHosts.userId, args.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    const reusableDomain = existing
      ? await cleanupExistingHost(db, existing, apiKey)
      : null;
    signal.throwIfAborted();

    const refs: {
      botUserId?: string;
      credentialId?: string;
      domainId?: string;
      endpointId?: string;
    } = {};

    const result = await settle(
      provisionAndPersistHost(
        { db, args, apiKey, reusableDomain, refs },
        signal,
      ),
    );
    signal.throwIfAborted();
    if (result.ok) {
      return result.value;
    }
    log.error("Failed to register host, cleaning up", {
      orgId: args.orgId,
      userId: args.userId,
    });
    await rollbackNgrokResources(apiKey, refs, reusableDomain);
    signal.throwIfAborted();
    throw result.error;
  },
);

export const unregisterHost$ = command(
  async (
    { set },
    args: HostArgs,
    signal: AbortSignal,
  ): Promise<UnregisterHostResult> => {
    const db = set(writeDb$);

    const [host] = await db
      .select()
      .from(computerUseHosts)
      .where(
        and(
          eq(computerUseHosts.orgId, args.orgId),
          eq(computerUseHosts.userId, args.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!host) {
      return { kind: "not_found" };
    }

    const apiKey = optionalEnv("NGROK_API_KEY");

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
    signal.throwIfAborted();

    log.debug("Computer-use host unregistered", { orgId: args.orgId });
    return { kind: "ok" };
  },
);
