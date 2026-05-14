import { createHash, randomBytes, randomInt } from "crypto";
import { command } from "ccstate";
import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import type {
  LocalBrowserCommandError,
  LocalBrowserCommandResult,
  LocalBrowserHostStatus,
  LocalBrowserReadCommandKind,
} from "@vm0/api-contracts/contracts/zero-local-browser";
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
  publishLocalBrowserHostCommandAvailable,
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
const LOCAL_BROWSER_READ_COMMANDS = [
  "tabs.list",
  "tabs.current",
  "page.snapshot",
  "page.screenshot",
  "page.selection",
  "page.metadata",
] as const satisfies readonly LocalBrowserReadCommandKind[];

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

type CreateLocalBrowserReadCommandResult =
  | {
      readonly status: "created";
      readonly commandId: string;
      readonly commandStatus: "queued";
    }
  | { readonly status: "no_connector" }
  | { readonly status: "no_host" }
  | { readonly status: "host_not_found" }
  | { readonly status: "host_ambiguous" }
  | { readonly status: "host_offline" }
  | { readonly status: "host_unsupported" };

type LocalBrowserCommandRow = typeof localBrowserCommands.$inferSelect;
type LocalBrowserHostRow = typeof localBrowserHosts.$inferSelect;

type ResolveLocalBrowserCommandTargetsResult =
  | {
      readonly status: "resolved";
      readonly targetHostId?: string;
      readonly notifyHosts: readonly LocalBrowserHostRow[];
    }
  | { readonly status: "host_not_found" }
  | { readonly status: "host_ambiguous" }
  | { readonly status: "host_offline" }
  | { readonly status: "host_unsupported" };

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

function commandPayload(params: { readonly tabId?: string }) {
  return params.tabId ? { tabId: params.tabId.trim() } : {};
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

function localBrowserHostSupportsCommand(
  host: LocalBrowserHostRow,
  kind: LocalBrowserReadCommandKind,
): boolean {
  return host.supportedCapabilities.includes(kind);
}

function resolveTargetLocalBrowserHost(
  host: LocalBrowserHostRow,
  params: {
    readonly kind: LocalBrowserReadCommandKind;
    readonly now: Date;
  },
): ResolveLocalBrowserCommandTargetsResult {
  if (!localBrowserHostIsOnline(host, params.now)) {
    return { status: "host_offline" };
  }
  if (!localBrowserHostSupportsCommand(host, params.kind)) {
    return { status: "host_unsupported" };
  }
  return {
    status: "resolved",
    targetHostId: host.id,
    notifyHosts: [host],
  };
}

function resolveLocalBrowserCommandTargets(params: {
  readonly hosts: readonly LocalBrowserHostRow[];
  readonly onlineHosts: readonly LocalBrowserHostRow[];
  readonly kind: LocalBrowserReadCommandKind;
  readonly hostId?: string;
  readonly hostName?: string;
  readonly now: Date;
}): ResolveLocalBrowserCommandTargetsResult {
  if (params.hostId) {
    const host = params.hosts.find((row) => {
      return row.id === params.hostId;
    });
    return host
      ? resolveTargetLocalBrowserHost(host, params)
      : { status: "host_not_found" };
  }

  if (params.hostName) {
    const matchingHosts = params.hosts.filter((row) => {
      return row.displayName === params.hostName;
    });
    if (matchingHosts.length > 1) {
      return { status: "host_ambiguous" };
    }
    const host = matchingHosts[0];
    return host
      ? resolveTargetLocalBrowserHost(host, params)
      : { status: "host_not_found" };
  }

  if (params.onlineHosts.length === 0) {
    return { status: "host_offline" };
  }

  const capableHosts = params.onlineHosts.filter((host) => {
    return localBrowserHostSupportsCommand(host, params.kind);
  });
  if (capableHosts.length === 0) {
    return { status: "host_unsupported" };
  }
  return {
    status: "resolved",
    notifyHosts: capableHosts,
  };
}

function serializeHost(row: LocalBrowserHostRow, now: Date) {
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

function commandErrorFromRow(
  row: LocalBrowserCommandRow,
): LocalBrowserCommandError | undefined {
  if (
    row.result &&
    typeof row.result.error === "object" &&
    row.result.error !== null &&
    "code" in row.result.error &&
    "message" in row.result.error &&
    typeof row.result.error.code === "string" &&
    typeof row.result.error.message === "string"
  ) {
    return {
      code: row.result.error.code as LocalBrowserCommandError["code"],
      message: row.result.error.message,
    };
  }

  if (row.error) {
    return {
      code: "unsupported_command",
      message: row.error,
    };
  }

  return undefined;
}

function serializeCommand(
  row: LocalBrowserCommandRow,
  hostName: string | null,
) {
  const result = row.status === "succeeded" ? row.result : null;
  return {
    id: row.id,
    kind: row.kind as LocalBrowserReadCommandKind,
    status: row.status as "queued" | "running" | "succeeded" | "failed",
    hostId: row.hostId,
    hostName,
    payload: row.payload,
    ...(result ? { result: result as LocalBrowserCommandResult } : {}),
    ...(row.status === "failed" ? { error: commandErrorFromRow(row) } : {}),
    timeoutMs: row.timeoutMs,
    createdAt: row.createdAt.toISOString(),
    claimedAt: row.claimedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
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

async function publishLocalBrowserCommandAvailableSafe(
  hostId: string,
  commandId: string,
  signal: AbortSignal,
): Promise<void> {
  const publishResult = await safeAsync(() => {
    return publishLocalBrowserHostCommandAvailable(hostId, commandId);
  });
  signal.throwIfAborted();
  if ("error" in publishResult) {
    L.warn("Failed to publish local-browser command notification", {
      hostId,
      commandId,
      error: publishResult.error,
    });
  }
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

export const createLocalBrowserReadCommand$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly runId?: string;
      readonly kind: LocalBrowserReadCommandKind;
      readonly tabId?: string;
      readonly hostId?: string;
      readonly hostName?: string;
      readonly timeoutMs: number;
    },
    signal: AbortSignal,
  ): Promise<CreateLocalBrowserReadCommandResult> => {
    const writeDb = set(writeDb$);
    const now = nowDate();

    if (!LOCAL_BROWSER_READ_COMMANDS.includes(params.kind)) {
      return { status: "host_unsupported" as const };
    }

    const [connector] = await writeDb
      .select({ id: connectors.id })
      .from(connectors)
      .where(
        and(
          eq(connectors.orgId, params.orgId),
          eq(connectors.userId, params.userId),
          eq(connectors.type, "local-browser"),
          eq(connectors.needsReconnect, false),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!connector) {
      return { status: "no_connector" as const };
    }

    const hosts = await writeDb
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

    if (hosts.length === 0) {
      return { status: "no_host" as const };
    }

    const onlineHosts = hosts.filter((host) => {
      return localBrowserHostIsOnline(host, now);
    });

    const target = resolveLocalBrowserCommandTargets({
      hosts,
      onlineHosts,
      kind: params.kind,
      hostId: params.hostId,
      hostName: params.hostName,
      now,
    });
    if (target.status !== "resolved") {
      return target;
    }

    const values = {
      orgId: params.orgId,
      userId: params.userId,
      runId: params.runId ?? null,
      hostId: target.targetHostId ?? null,
      kind: params.kind,
      status: "queued",
      payload: commandPayload({ tabId: params.tabId }),
      timeoutMs: params.timeoutMs,
      createdAt: now,
      updatedAt: now,
    };
    const [row] = await writeDb
      .insert(localBrowserCommands)
      .values(values)
      .returning({
        id: localBrowserCommands.id,
        status: localBrowserCommands.status,
      });
    signal.throwIfAborted();

    if (!row) {
      throw new Error("Failed to create local-browser command");
    }

    await Promise.all(
      target.notifyHosts.map((host) => {
        return publishLocalBrowserCommandAvailableSafe(host.id, row.id, signal);
      }),
    );
    signal.throwIfAborted();

    return {
      status: "created" as const,
      commandId: row.id,
      commandStatus: row.status as "queued",
    };
  },
);

export const getLocalBrowserReadCommand$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly commandId: string;
    },
    signal: AbortSignal,
  ) => {
    const writeDb = set(writeDb$);
    const [row] = await writeDb
      .select({
        command: localBrowserCommands,
        hostName: localBrowserHosts.displayName,
      })
      .from(localBrowserCommands)
      .leftJoin(
        localBrowserHosts,
        eq(localBrowserCommands.hostId, localBrowserHosts.id),
      )
      .where(
        and(
          eq(localBrowserCommands.id, params.commandId),
          eq(localBrowserCommands.orgId, params.orgId),
          eq(localBrowserCommands.userId, params.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    return row ? serializeCommand(row.command, row.hostName) : null;
  },
);

export const claimNextLocalBrowserHostCommand$ = command(
  async (
    { set },
    params: {
      readonly hostToken: string;
      readonly supportedCapabilities: readonly string[];
    },
    signal: AbortSignal,
  ) => {
    const writeDb = set(writeDb$);
    const now = nowDate();
    const supportedCapabilities = normalizeCapabilities(
      params.supportedCapabilities,
    );
    const supportedReadCommands = LOCAL_BROWSER_READ_COMMANDS.filter((kind) => {
      return supportedCapabilities.includes(kind);
    });

    return await writeDb.transaction(async (tx) => {
      const [host] = await tx
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

      if (!host) {
        return { status: "invalid_token" as const };
      }

      await tx
        .update(localBrowserHosts)
        .set({
          supportedCapabilities,
          status: "online",
          lastSeenAt: now,
          updatedAt: now,
        })
        .where(eq(localBrowserHosts.id, host.id));
      signal.throwIfAborted();

      if (supportedReadCommands.length === 0) {
        return { status: "idle" as const };
      }

      const rows = await tx
        .select()
        .from(localBrowserCommands)
        .where(
          and(
            eq(localBrowserCommands.orgId, host.orgId),
            eq(localBrowserCommands.userId, host.userId),
            eq(localBrowserCommands.status, "queued"),
            inArray(localBrowserCommands.kind, supportedReadCommands),
            or(
              isNull(localBrowserCommands.hostId),
              eq(localBrowserCommands.hostId, host.id),
            ),
          ),
        )
        .orderBy(asc(localBrowserCommands.createdAt))
        .for("update")
        .limit(1);
      signal.throwIfAborted();

      const commandRow = rows[0];
      if (!commandRow) {
        return { status: "idle" as const };
      }

      const [claimed] = await tx
        .update(localBrowserCommands)
        .set({
          hostId: host.id,
          status: "running",
          claimedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(localBrowserCommands.id, commandRow.id),
            eq(localBrowserCommands.status, "queued"),
            or(
              isNull(localBrowserCommands.hostId),
              eq(localBrowserCommands.hostId, host.id),
            ),
          ),
        )
        .returning({
          id: localBrowserCommands.id,
          kind: localBrowserCommands.kind,
          payload: localBrowserCommands.payload,
          timeoutMs: localBrowserCommands.timeoutMs,
        });
      signal.throwIfAborted();

      if (!claimed) {
        return { status: "idle" as const };
      }

      return {
        status: "command" as const,
        command: {
          id: claimed.id,
          kind: claimed.kind as LocalBrowserReadCommandKind,
          payload: claimed.payload,
          timeoutMs: claimed.timeoutMs,
        },
      };
    });
  },
);

export const completeLocalBrowserHostCommand$ = command(
  async (
    { set },
    params: {
      readonly hostToken: string;
      readonly commandId: string;
      readonly status: "succeeded" | "failed";
      readonly result?: LocalBrowserCommandResult;
      readonly error?: LocalBrowserCommandError;
    },
    signal: AbortSignal,
  ) => {
    const writeDb = set(writeDb$);
    const now = nowDate();

    return await writeDb.transaction(async (tx) => {
      const [host] = await tx
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

      if (!host) {
        return { status: "invalid_token" as const };
      }

      const [commandRow] = await tx
        .select()
        .from(localBrowserCommands)
        .where(
          and(
            eq(localBrowserCommands.id, params.commandId),
            eq(localBrowserCommands.hostId, host.id),
          ),
        )
        .for("update")
        .limit(1);
      signal.throwIfAborted();

      if (!commandRow) {
        return { status: "not_found" as const };
      }
      if (commandRow.status !== "running") {
        return { status: "not_running" as const };
      }

      await tx
        .update(localBrowserCommands)
        .set({
          status: params.status,
          result:
            params.status === "succeeded"
              ? (params.result as Record<string, unknown>)
              : { error: params.error },
          error: params.status === "failed" ? params.error?.code : null,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(localBrowserCommands.id, commandRow.id));
      signal.throwIfAborted();

      return { status: "completed" as const };
    });
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
