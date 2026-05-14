import { command } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";
import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import { connectors } from "@vm0/db/schema/connector";
import { localBrowserHosts } from "@vm0/db/schema/local-browser";

import { writeDb$ } from "../external/db";
import { nowDate } from "../external/time";
import { publishUserSignal } from "../external/realtime";
import { safeAsync } from "../utils";
import { logger } from "../../lib/log";

const LOCAL_BROWSER_HOST_CLOSED_AFTER_MS = 90 * 1000;
const L = logger("ZeroLocalBrowser");

function localBrowserHostIsOnline(
  host: typeof localBrowserHosts.$inferSelect,
  now: Date,
): boolean {
  return (
    host.status === "online" &&
    now.getTime() - host.lastSeenAt.getTime() <=
      LOCAL_BROWSER_HOST_CLOSED_AFTER_MS
  );
}

function serializeLocalBrowserConnector(
  row: typeof connectors.$inferSelect,
): ConnectorResponse {
  return {
    id: row.id,
    type: "local-browser",
    authMethod: row.authMethod,
    externalId: row.externalId,
    externalUsername: row.externalUsername,
    externalEmail: row.externalEmail,
    oauthScopes: row.oauthScopes ? JSON.parse(row.oauthScopes) : null,
    needsReconnect: row.needsReconnect,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function publishConnectorChangedSafe(
  userId: string,
  signal: AbortSignal,
): Promise<void> {
  const publishResult = await safeAsync(() => {
    return publishUserSignal([userId], "connector:changed");
  });
  signal.throwIfAborted();
  if ("error" in publishResult) {
    L.warn("Failed to publish connector change", {
      userId,
      error: publishResult.error,
    });
  }
}

export const connectLocalBrowserConnector$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<
    | { readonly status: "connected"; readonly connector: ConnectorResponse }
    | { readonly status: "no_online_host" }
  > => {
    const writeDb = set(writeDb$);
    const now = nowDate();
    const hostRows = await writeDb
      .select()
      .from(localBrowserHosts)
      .where(
        and(
          eq(localBrowserHosts.orgId, params.orgId),
          eq(localBrowserHosts.userId, params.userId),
          isNull(localBrowserHosts.revokedAt),
        ),
      );
    signal.throwIfAborted();

    const hasOnlineHost = hostRows.some((host) => {
      return localBrowserHostIsOnline(host, now);
    });
    if (!hasOnlineHost) {
      return { status: "no_online_host" as const };
    }

    const [row] = await writeDb
      .insert(connectors)
      .values({
        type: "local-browser",
        authMethod: "api",
        externalId: null,
        externalUsername: null,
        externalEmail: null,
        oauthScopes: null,
        tokenExpiresAt: null,
        needsReconnect: false,
        userId: params.userId,
        orgId: params.orgId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [connectors.orgId, connectors.userId, connectors.type],
        set: {
          authMethod: "api",
          externalId: null,
          externalUsername: null,
          externalEmail: null,
          oauthScopes: null,
          tokenExpiresAt: null,
          needsReconnect: false,
          updatedAt: now,
        },
      })
      .returning();
    signal.throwIfAborted();

    if (!row) {
      throw new Error("Failed to connect local-browser connector");
    }

    await publishConnectorChangedSafe(params.userId, signal);

    return {
      status: "connected" as const,
      connector: serializeLocalBrowserConnector(row),
    };
  },
);
