import { createHash, randomUUID } from "node:crypto";

import type { ComputerConnectorCreateResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { and, eq } from "drizzle-orm";
import { command } from "ccstate";

import { optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
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
import { encryptSecretValue } from "./crypto.utils";

const log = logger("service:computer-connector");

const COMPUTER_CONNECTOR_SECRET_NAMES = Object.freeze([
  "COMPUTER_CONNECTOR_BRIDGE_TOKEN",
  "COMPUTER_CONNECTOR_DOMAIN_ID",
  "COMPUTER_CONNECTOR_DOMAIN",
] as const);

interface CreateComputerConnectorArgs {
  readonly orgId: string;
  readonly userId: string;
}

type CreateComputerConnectorResult =
  | {
      readonly kind: "created";
      readonly connector: ComputerConnectorCreateResponse;
    }
  | { readonly kind: "bad_request" }
  | { readonly kind: "conflict" };

interface ProvisionedRefs {
  botUserId?: string;
  credentialId?: string;
  domainId?: string;
  endpointId?: string;
  connectorId?: string;
}

interface ProvisionContext {
  readonly db: Db;
  readonly args: CreateComputerConnectorArgs;
  readonly apiKey: string;
  readonly refs: ProvisionedRefs;
}

function connectorSlug(orgId: string): string {
  return createHash("sha256").update(orgId).digest("hex").substring(0, 12);
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
            config: { status_code: 502, body: "Agent offline" },
          },
        ],
      },
    ],
  });
}

async function upsertConnectorSecret(
  db: Db,
  args: CreateComputerConnectorArgs,
  name: (typeof COMPUTER_CONNECTOR_SECRET_NAMES)[number],
  value: string,
): Promise<void> {
  const encryptedValue = encryptSecretValue(value);
  await db
    .insert(secrets)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      name,
      encryptedValue,
      type: "connector",
      description: `Computer connector: ${name}`,
    })
    .onConflictDoUpdate({
      target: [secrets.orgId, secrets.userId, secrets.name, secrets.type],
      set: {
        encryptedValue,
        description: `Computer connector: ${name}`,
        updatedAt: nowDate(),
      },
    });
}

async function deleteComputerConnectorSecrets(
  db: Db,
  args: CreateComputerConnectorArgs,
): Promise<void> {
  for (const name of COMPUTER_CONNECTOR_SECRET_NAMES) {
    await db
      .delete(secrets)
      .where(
        and(
          eq(secrets.orgId, args.orgId),
          eq(secrets.userId, args.userId),
          eq(secrets.name, name),
          eq(secrets.type, "connector"),
        ),
      );
  }
}

async function rollbackDbState(
  db: Db,
  args: CreateComputerConnectorArgs,
  refs: ProvisionedRefs,
): Promise<void> {
  const result = await settle(
    (async () => {
      await deleteComputerConnectorSecrets(db, args);
      if (refs.connectorId) {
        await db.delete(connectors).where(eq(connectors.id, refs.connectorId));
      }
    })(),
  );
  if (!result.ok) {
    log.warn("Failed to clean up computer connector DB state", {
      orgId: args.orgId,
      error:
        result.error instanceof Error
          ? result.error.message
          : String(result.error),
    });
  }
}

async function rollbackNgrokResources(
  apiKey: string,
  refs: ProvisionedRefs,
): Promise<void> {
  if (refs.endpointId) {
    const endpointId = refs.endpointId;
    await safeDelete(
      () => {
        return deleteCloudEndpoint(apiKey, endpointId);
      },
      "Cloud endpoint",
      endpointId,
      true,
    );
  }
  if (refs.credentialId) {
    const credentialId = refs.credentialId;
    await safeDelete(
      () => {
        return deleteCredential(apiKey, credentialId);
      },
      "Credential",
      credentialId,
      true,
    );
  }
  if (refs.domainId) {
    const domainId = refs.domainId;
    await safeDelete(
      () => {
        return deleteReservedDomain(apiKey, domainId);
      },
      "Reserved domain",
      domainId,
      true,
    );
  }
  if (refs.botUserId) {
    const botUserId = refs.botUserId;
    await safeDelete(
      () => {
        return deleteBotUser(apiKey, botUserId);
      },
      "Bot user",
      botUserId,
      true,
    );
  }
}

async function provisionAndPersistConnector(
  ctx: ProvisionContext,
  signal: AbortSignal,
): Promise<ComputerConnectorCreateResponse> {
  const { db, args, apiKey, refs } = ctx;
  const slug = connectorSlug(args.orgId);
  const subdomainName = `vm0-user-${slug}`;
  const endpointPrefix = `vm0-user-${slug}`;
  const botUserName = `vm0-user-${slug}`;

  const botUser = await findOrCreateBotUser(apiKey, botUserName);
  signal.throwIfAborted();
  refs.botUserId = botUser.id;

  const credential = await createCredential(apiKey, botUser.id, [
    `bind:*.${endpointPrefix}.internal`,
  ]);
  signal.throwIfAborted();
  refs.credentialId = credential.id;

  const reservedDomain = await findOrCreateReservedDomain(
    apiKey,
    subdomainName,
    "us",
  );
  signal.throwIfAborted();
  refs.domainId = reservedDomain.id;
  const domain = reservedDomain.domain;

  const bridgeToken = randomUUID();
  const cloudEndpoint = await ensureCloudEndpoint(
    apiKey,
    `https://*.${domain}`,
    buildTrafficPolicy(domain, endpointPrefix, bridgeToken),
  );
  signal.throwIfAborted();
  refs.endpointId = cloudEndpoint.id;

  const [connectorRow] = await db
    .insert(connectors)
    .values({
      userId: args.userId,
      orgId: args.orgId,
      type: "computer",
      authMethod: "api",
      externalId: refs.botUserId,
      externalUsername: refs.credentialId,
      externalEmail: refs.endpointId,
      oauthScopes: null,
    })
    .returning({ id: connectors.id });
  signal.throwIfAborted();

  if (!connectorRow) {
    throw new Error("Failed to create computer connector");
  }
  refs.connectorId = connectorRow.id;

  await upsertConnectorSecret(
    db,
    args,
    "COMPUTER_CONNECTOR_BRIDGE_TOKEN",
    bridgeToken,
  );
  signal.throwIfAborted();
  await upsertConnectorSecret(
    db,
    args,
    "COMPUTER_CONNECTOR_DOMAIN_ID",
    refs.domainId,
  );
  signal.throwIfAborted();
  await upsertConnectorSecret(db, args, "COMPUTER_CONNECTOR_DOMAIN", domain);
  signal.throwIfAborted();

  log.debug("Computer connector created", {
    connectorId: connectorRow.id,
    botUserId: refs.botUserId,
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

export const createComputerConnector$ = command(
  async (
    { set },
    args: CreateComputerConnectorArgs,
    signal: AbortSignal,
  ): Promise<CreateComputerConnectorResult> => {
    const db = set(writeDb$);

    const [existing] = await db
      .select({ id: connectors.id })
      .from(connectors)
      .where(
        and(eq(connectors.orgId, args.orgId), eq(connectors.type, "computer")),
      )
      .limit(1);
    signal.throwIfAborted();

    if (existing) {
      return { kind: "conflict" };
    }

    const apiKey = optionalEnv("NGROK_API_KEY");
    if (!apiKey) {
      return { kind: "bad_request" };
    }

    const refs: ProvisionedRefs = {};
    const result = await settle(
      provisionAndPersistConnector({ db, args, apiKey, refs }, signal),
    );
    signal.throwIfAborted();

    if (result.ok) {
      return { kind: "created", connector: result.value };
    }

    log.error("Failed to create computer connector, cleaning up", {
      orgId: args.orgId,
    });
    await rollbackDbState(db, args, refs);
    signal.throwIfAborted();
    await rollbackNgrokResources(apiKey, refs);
    signal.throwIfAborted();

    throw result.error;
  },
);
