import { createHash, randomBytes, randomInt } from "crypto";
import { command } from "ccstate";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import type { LocalBrowserHostStatus } from "@vm0/api-contracts/contracts/zero-local-browser";
import { connectors } from "@vm0/db/schema/connector";
import {
  localBrowserCommands,
  localBrowserDeviceCodes,
  localBrowserHosts,
} from "@vm0/db/schema/local-browser";

import { writeDb$ } from "../external/db";
import { nowDate } from "../external/time";
import {
  createLocalBrowserDeviceRealtimeSubscription,
  createLocalBrowserHostRealtimeSubscription,
  publishLocalBrowserDeviceApproved,
  publishLocalBrowserHostsChanged,
  publishUserSignal,
} from "../external/realtime";
import { safeAsync } from "../utils";
import { logger } from "../../lib/log";

const LOCAL_BROWSER_DEVICE_CODE_TTL_SECONDS = 15 * 60;
const LOCAL_BROWSER_POLL_INTERVAL_SECONDS = 5;
const LOCAL_BROWSER_HOST_CLOSED_AFTER_MS = 90 * 1000;
const LOCAL_BROWSER_VERIFICATION_PATH = "/zero/connectors/local-browser";
const L = logger("ZeroLocalBrowser");

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

interface CreateLocalBrowserDeviceCodeResult {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationPath: string;
  readonly expiresIn: number;
  readonly interval: number;
  readonly pollToken: string;
  readonly realtime?: Awaited<
    ReturnType<typeof createLocalBrowserDeviceRealtimeSubscription>
  >;
}

type ClaimLocalBrowserDeviceCodeResult =
  | { readonly status: "approved" }
  | { readonly status: "not_found" }
  | { readonly status: "expired" }
  | { readonly status: "already_claimed" };

type PollLocalBrowserDeviceCodeResult =
  | { readonly status: "pending" }
  | {
      readonly status: "linked";
      readonly hostId: string;
      readonly hostToken?: string;
    }
  | { readonly status: "expired" }
  | { readonly status: "invalid" };

function generateCode(length = 8): string {
  let code = "";
  for (let i = 0; i < length; i++) {
    if (i > 0 && i % 4 === 0) {
      code += "-";
    }
    code += CODE_CHARS[randomInt(CODE_CHARS.length)];
  }
  return code;
}

function normalizeDeviceCode(code: string): string {
  return code.trim().toUpperCase().replace(/[\s-]/g, "");
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function generateOpaqueToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function normalizeHostName(hostName: string): string {
  return hostName.trim().slice(0, 128);
}

function normalizeBrowser(browser: string): string {
  return browser.trim().slice(0, 64);
}

function normalizeExtensionVersion(extensionVersion: string): string {
  return extensionVersion.trim().slice(0, 64);
}

function normalizeCapabilities(capabilities: readonly string[]): string[] {
  return [
    ...new Set(
      capabilities.map((capability) => {
        return capability.trim();
      }),
    ),
  ]
    .filter((capability) => {
      return capability.length > 0;
    })
    .slice(0, 50);
}

function hasExpired(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() <= now.getTime();
}

function localBrowserHostStatus(
  host: typeof localBrowserHosts.$inferSelect,
  now: Date,
): LocalBrowserHostStatus {
  if (
    host.status !== "online" ||
    now.getTime() - host.lastSeenAt.getTime() >
      LOCAL_BROWSER_HOST_CLOSED_AFTER_MS
  ) {
    return "offline";
  }
  return "online";
}

function localBrowserHostIsOnline(
  host: typeof localBrowserHosts.$inferSelect,
  now: Date,
): boolean {
  return localBrowserHostStatus(host, now) === "online";
}

function serializeHost(row: typeof localBrowserHosts.$inferSelect, now: Date) {
  return {
    id: row.id,
    displayName: row.displayName,
    browser: row.browser,
    extensionVersion: row.extensionVersion,
    supportedCapabilities: row.supportedCapabilities,
    status: localBrowserHostStatus(row, now),
    lastSeenAt: row.lastSeenAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
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

async function publishLocalBrowserHostsChangedSafe(
  userId: string,
  signal: AbortSignal,
): Promise<void> {
  const publishResult = await safeAsync(() => {
    return publishLocalBrowserHostsChanged(userId);
  });
  signal.throwIfAborted();
  if ("error" in publishResult) {
    L.warn("Failed to publish local-browser host change", {
      userId,
      error: publishResult.error,
    });
  }
}

async function publishConnectorAndHostsChangedSafe(
  userId: string,
  signal: AbortSignal,
): Promise<void> {
  await Promise.all([
    publishConnectorChangedSafe(userId, signal),
    publishLocalBrowserHostsChangedSafe(userId, signal),
  ]);
}

export const createLocalBrowserDeviceCode$ = command(
  async (
    { set },
    params: {
      readonly hostName: string;
      readonly browser: string;
      readonly extensionVersion: string;
      readonly supportedCapabilities: readonly string[];
    },
    signal: AbortSignal,
  ): Promise<CreateLocalBrowserDeviceCodeResult> => {
    const writeDb = set(writeDb$);
    const userCode = generateCode();
    const pollToken = generateOpaqueToken("vm0_local_browser_poll");
    const now = nowDate();
    const expiresAt = new Date(
      now.getTime() + LOCAL_BROWSER_DEVICE_CODE_TTL_SECONDS * 1000,
    );

    const [row] = await writeDb
      .insert(localBrowserDeviceCodes)
      .values({
        codeHash: hashSecret(normalizeDeviceCode(userCode)),
        pollTokenHash: hashSecret(pollToken),
        hostName: normalizeHostName(params.hostName),
        browser: normalizeBrowser(params.browser),
        extensionVersion: normalizeExtensionVersion(params.extensionVersion),
        supportedCapabilities: normalizeCapabilities(
          params.supportedCapabilities,
        ),
        status: "pending",
        expiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: localBrowserDeviceCodes.id });
    signal.throwIfAborted();

    if (!row) {
      throw new Error("Failed to create local-browser device code");
    }

    let realtime:
      | Awaited<ReturnType<typeof createLocalBrowserDeviceRealtimeSubscription>>
      | undefined;
    const realtimeResult = await safeAsync(() => {
      return createLocalBrowserDeviceRealtimeSubscription(row.id);
    });
    signal.throwIfAborted();
    if ("ok" in realtimeResult) {
      realtime = realtimeResult.ok;
    } else {
      L.warn(
        "Failed to create local-browser device realtime token",
        realtimeResult.error,
      );
    }

    return {
      deviceCode: userCode,
      userCode,
      verificationPath: LOCAL_BROWSER_VERIFICATION_PATH,
      expiresIn: LOCAL_BROWSER_DEVICE_CODE_TTL_SECONDS,
      interval: LOCAL_BROWSER_POLL_INTERVAL_SECONDS,
      pollToken,
      realtime,
    };
  },
);

export const claimLocalBrowserDeviceCode$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly deviceCode: string;
    },
    signal: AbortSignal,
  ): Promise<ClaimLocalBrowserDeviceCodeResult> => {
    const writeDb = set(writeDb$);
    const now = nowDate();
    const codeHash = hashSecret(normalizeDeviceCode(params.deviceCode));

    const result = await writeDb.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(localBrowserDeviceCodes)
        .where(eq(localBrowserDeviceCodes.codeHash, codeHash))
        .for("update")
        .limit(1);
      signal.throwIfAborted();

      if (!row) {
        return { status: "not_found" as const };
      }

      if (
        (row.orgId && row.orgId !== params.orgId) ||
        (row.userId && row.userId !== params.userId)
      ) {
        return { status: "not_found" as const };
      }

      if (hasExpired(row.expiresAt, now)) {
        await tx
          .update(localBrowserDeviceCodes)
          .set({ status: "expired", updatedAt: now })
          .where(eq(localBrowserDeviceCodes.id, row.id));
        signal.throwIfAborted();
        return { status: "expired" as const };
      }

      if (
        row.status === "approved" &&
        row.orgId === params.orgId &&
        row.userId === params.userId
      ) {
        return {
          status: "approved" as const,
          deviceCodeId: row.id,
        };
      }

      if (row.status !== "pending") {
        return { status: "already_claimed" as const };
      }

      await tx
        .update(localBrowserDeviceCodes)
        .set({
          orgId: params.orgId,
          userId: params.userId,
          status: "approved",
          claimedAt: now,
          updatedAt: now,
        })
        .where(eq(localBrowserDeviceCodes.id, row.id));
      signal.throwIfAborted();

      return {
        status: "approved" as const,
        deviceCodeId: row.id,
      };
    });
    signal.throwIfAborted();

    if (result.status === "approved") {
      await publishLocalBrowserDeviceApproved(result.deviceCodeId);
      signal.throwIfAborted();
      return { status: "approved" as const };
    }

    return result;
  },
);

export const pollLocalBrowserDeviceCode$ = command(
  async (
    { set },
    params: {
      readonly deviceCode: string;
      readonly pollToken: string;
    },
    signal: AbortSignal,
  ): Promise<PollLocalBrowserDeviceCodeResult> => {
    const writeDb = set(writeDb$);
    const now = nowDate();
    const codeHash = hashSecret(normalizeDeviceCode(params.deviceCode));
    const pollTokenHash = hashSecret(params.pollToken);

    const result = await writeDb.transaction(
      async (
        tx,
      ): Promise<PollLocalBrowserDeviceCodeResult & { userId?: string }> => {
        const [row] = await tx
          .select()
          .from(localBrowserDeviceCodes)
          .where(
            and(
              eq(localBrowserDeviceCodes.codeHash, codeHash),
              eq(localBrowserDeviceCodes.pollTokenHash, pollTokenHash),
            ),
          )
          .for("update")
          .limit(1);
        signal.throwIfAborted();

        if (!row) {
          return { status: "invalid" as const };
        }

        if (hasExpired(row.expiresAt, now) && row.status !== "consumed") {
          await tx
            .update(localBrowserDeviceCodes)
            .set({ status: "expired", updatedAt: now })
            .where(eq(localBrowserDeviceCodes.id, row.id));
          signal.throwIfAborted();
          return { status: "expired" as const };
        }

        if (row.status === "pending") {
          return { status: "pending" as const };
        }

        if (row.status === "consumed" && row.hostId) {
          return {
            status: "linked" as const,
            hostId: row.hostId,
            ...(row.userId ? { userId: row.userId } : {}),
          };
        }

        if (row.status !== "approved") {
          return { status: "expired" as const };
        }

        if (!row.orgId || !row.userId) {
          return { status: "invalid" as const };
        }

        const hostToken = generateOpaqueToken("vm0_local_browser_host");
        const [host] = await tx
          .insert(localBrowserHosts)
          .values({
            orgId: row.orgId,
            userId: row.userId,
            displayName: normalizeHostName(row.hostName),
            tokenHash: hashSecret(hostToken),
            browser: normalizeBrowser(row.browser),
            extensionVersion: normalizeExtensionVersion(row.extensionVersion),
            supportedCapabilities: normalizeCapabilities(
              row.supportedCapabilities,
            ),
            status: "online",
            lastSeenAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: localBrowserHosts.id });
        signal.throwIfAborted();

        if (!host) {
          throw new Error("Failed to link local-browser host");
        }

        await tx
          .update(localBrowserDeviceCodes)
          .set({
            status: "consumed",
            hostId: host.id,
            consumedAt: now,
            updatedAt: now,
          })
          .where(eq(localBrowserDeviceCodes.id, row.id));
        signal.throwIfAborted();

        return {
          status: "linked" as const,
          hostId: host.id,
          hostToken,
          userId: row.userId,
        };
      },
    );
    signal.throwIfAborted();

    if (result.status === "linked" && result.userId) {
      await publishConnectorAndHostsChangedSafe(result.userId, signal);
      const { userId: _userId, ...publicResult } = result;
      return publicResult;
    }

    return result;
  },
);

export const heartbeatLocalBrowserHost$ = command(
  async (
    { set },
    params: {
      readonly hostToken: string;
      readonly hostName: string;
      readonly browser: string;
      readonly extensionVersion: string;
      readonly supportedCapabilities: readonly string[];
    },
    signal: AbortSignal,
  ): Promise<{ readonly hostId: string } | null> => {
    const writeDb = set(writeDb$);
    const now = nowDate();
    const [existing] = await writeDb
      .select()
      .from(localBrowserHosts)
      .where(
        and(
          eq(localBrowserHosts.tokenHash, hashSecret(params.hostToken)),
          isNull(localBrowserHosts.revokedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!existing) {
      return null;
    }

    const wasOnline = localBrowserHostStatus(existing, now) === "online";
    const [row] = await writeDb
      .update(localBrowserHosts)
      .set({
        displayName: normalizeHostName(params.hostName),
        browser: normalizeBrowser(params.browser),
        extensionVersion: normalizeExtensionVersion(params.extensionVersion),
        supportedCapabilities: normalizeCapabilities(
          params.supportedCapabilities,
        ),
        status: "online",
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(eq(localBrowserHosts.id, existing.id))
      .returning({
        id: localBrowserHosts.id,
        userId: localBrowserHosts.userId,
      });
    signal.throwIfAborted();

    if (!row) {
      return null;
    }

    if (!wasOnline) {
      await publishLocalBrowserHostsChangedSafe(row.userId, signal);
    }

    return { hostId: row.id };
  },
);

export const createLocalBrowserHostRealtimeToken$ = command(
  async (
    { set },
    params: {
      readonly hostToken: string;
    },
    signal: AbortSignal,
  ) => {
    const writeDb = set(writeDb$);
    const [host] = await writeDb
      .select({ id: localBrowserHosts.id })
      .from(localBrowserHosts)
      .where(
        and(
          eq(localBrowserHosts.tokenHash, hashSecret(params.hostToken)),
          isNull(localBrowserHosts.revokedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!host) {
      return null;
    }

    return await createLocalBrowserHostRealtimeSubscription(host.id);
  },
);

export const listLocalBrowserHosts$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ) => {
    const writeDb = set(writeDb$);
    const now = nowDate();
    const rows = await writeDb
      .select()
      .from(localBrowserHosts)
      .where(
        and(
          eq(localBrowserHosts.orgId, params.orgId),
          eq(localBrowserHosts.userId, params.userId),
          isNull(localBrowserHosts.revokedAt),
        ),
      )
      .orderBy(desc(localBrowserHosts.lastSeenAt));
    signal.throwIfAborted();

    return {
      hosts: rows.map((row) => {
        return serializeHost(row, now);
      }),
    };
  },
);

export const startLocalBrowserHost$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly hostName: string;
      readonly browser: string;
      readonly extensionVersion: string;
      readonly supportedCapabilities: readonly string[];
      readonly hostId?: string;
    },
    signal: AbortSignal,
  ) => {
    const writeDb = set(writeDb$);
    const now = nowDate();
    const hostToken = generateOpaqueToken("vm0_local_browser_host");
    const values = {
      displayName: normalizeHostName(params.hostName),
      tokenHash: hashSecret(hostToken),
      browser: normalizeBrowser(params.browser),
      extensionVersion: normalizeExtensionVersion(params.extensionVersion),
      supportedCapabilities: normalizeCapabilities(
        params.supportedCapabilities,
      ),
      status: "online",
      lastSeenAt: now,
      updatedAt: now,
    };

    if (params.hostId) {
      const [host] = await writeDb
        .update(localBrowserHosts)
        .set(values)
        .where(
          and(
            eq(localBrowserHosts.id, params.hostId),
            eq(localBrowserHosts.orgId, params.orgId),
            eq(localBrowserHosts.userId, params.userId),
            isNull(localBrowserHosts.revokedAt),
          ),
        )
        .returning({ id: localBrowserHosts.id });
      signal.throwIfAborted();

      if (!host) {
        return { status: "not_found" as const };
      }

      await publishLocalBrowserHostsChangedSafe(params.userId, signal);

      return {
        status: "started" as const,
        hostId: host.id,
        hostToken,
      };
    }

    const [host] = await writeDb
      .insert(localBrowserHosts)
      .values({
        orgId: params.orgId,
        userId: params.userId,
        ...values,
        createdAt: now,
      })
      .returning({ id: localBrowserHosts.id });
    signal.throwIfAborted();

    if (!host) {
      throw new Error("Failed to start local-browser host");
    }

    await publishLocalBrowserHostsChangedSafe(params.userId, signal);

    return {
      status: "started" as const,
      hostId: host.id,
      hostToken,
    };
  },
);

export const deleteLocalBrowserHost$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly hostId: string;
    },
    signal: AbortSignal,
  ) => {
    const writeDb = set(writeDb$);
    const now = nowDate();

    const result = await writeDb.transaction(async (tx) => {
      const [host] = await tx
        .update(localBrowserHosts)
        .set({
          status: "offline",
          revokedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(localBrowserHosts.id, params.hostId),
            eq(localBrowserHosts.orgId, params.orgId),
            eq(localBrowserHosts.userId, params.userId),
            isNull(localBrowserHosts.revokedAt),
          ),
        )
        .returning({ id: localBrowserHosts.id });
      signal.throwIfAborted();

      if (!host) {
        return { status: "not_found" as const };
      }

      await tx
        .update(localBrowserCommands)
        .set({
          status: "failed",
          error: "Local-browser host was revoked",
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(localBrowserCommands.hostId, host.id),
            inArray(localBrowserCommands.status, ["queued", "running"]),
          ),
        );
      signal.throwIfAborted();

      return { status: "deleted" as const };
    });
    signal.throwIfAborted();

    if (result.status === "deleted") {
      await publishLocalBrowserHostsChangedSafe(params.userId, signal);
    }

    return result;
  },
);

export const revokeLocalBrowserHostToken$ = command(
  async (
    { set },
    params: {
      readonly hostToken: string;
    },
    signal: AbortSignal,
  ) => {
    const writeDb = set(writeDb$);
    const now = nowDate();

    const result = await writeDb.transaction(async (tx) => {
      const [host] = await tx
        .update(localBrowserHosts)
        .set({
          status: "offline",
          revokedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(localBrowserHosts.tokenHash, hashSecret(params.hostToken)),
            isNull(localBrowserHosts.revokedAt),
          ),
        )
        .returning({
          id: localBrowserHosts.id,
          userId: localBrowserHosts.userId,
        });
      signal.throwIfAborted();

      if (!host) {
        return { status: "invalid_token" as const };
      }

      await tx
        .update(localBrowserCommands)
        .set({
          status: "failed",
          error: "Local-browser host was revoked",
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(localBrowserCommands.hostId, host.id),
            inArray(localBrowserCommands.status, ["queued", "running"]),
          ),
        );
      signal.throwIfAborted();

      return {
        status: "deleted" as const,
        userId: host.userId,
      };
    });
    signal.throwIfAborted();

    if (result.status === "deleted") {
      await publishLocalBrowserHostsChangedSafe(result.userId, signal);
    }

    return result;
  },
);

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
