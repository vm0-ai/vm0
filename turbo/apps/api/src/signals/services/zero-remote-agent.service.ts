import { createHash, randomBytes, randomInt } from "crypto";
import { command } from "ccstate";
import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import type {
  RemoteAgentBackend,
  RemoteAgentHostStatus,
} from "@vm0/api-contracts/contracts/zero-remote-agent";
import { connectors } from "@vm0/db/schema/connector";
import {
  remoteAgentDeviceCodes,
  remoteAgentHosts,
  remoteAgentJobs,
} from "@vm0/db/schema/remote-agent";

import { writeDb$ } from "../external/db";
import { nowDate } from "../external/time";
import {
  createRemoteAgentDeviceRealtimeSubscription,
  createRemoteAgentHostRealtimeSubscription,
  publishRemoteAgentDeviceApproved,
  publishRemoteAgentHostsChanged,
  publishRemoteAgentHostJobAvailable,
  publishUserSignal,
} from "../external/realtime";
import { safeAsync } from "../utils";
import { logger } from "../../lib/log";

const REMOTE_AGENT_DEVICE_CODE_TTL_SECONDS = 15 * 60;
const REMOTE_AGENT_POLL_INTERVAL_SECONDS = 5;
const REMOTE_AGENT_HOST_CLOSED_AFTER_MS = 90 * 1000;
const REMOTE_AGENT_VERIFICATION_PATH = "/zero/connectors/remote-agent";
const L = logger("ZeroRemoteAgent");

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

interface CreateRemoteAgentDeviceCodeResult {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationPath: string;
  readonly expiresIn: number;
  readonly interval: number;
  readonly pollToken: string;
  readonly realtime?: Awaited<
    ReturnType<typeof createRemoteAgentDeviceRealtimeSubscription>
  >;
}

type ClaimRemoteAgentDeviceCodeResult =
  | { readonly status: "approved" }
  | { readonly status: "not_found" }
  | { readonly status: "expired" }
  | { readonly status: "already_claimed" };

type PollRemoteAgentDeviceCodeResult =
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

function normalizeBackends(
  backends: readonly RemoteAgentBackend[],
): RemoteAgentBackend[] {
  return [...new Set(backends)];
}

function normalizeHostName(hostName: string): string {
  return hostName.trim().slice(0, 128);
}

function hasExpired(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() <= now.getTime();
}

function serializeJob(row: typeof remoteAgentJobs.$inferSelect) {
  return {
    id: row.id,
    hostId: row.hostId,
    backend: row.backend as RemoteAgentBackend | null,
    prompt: row.prompt,
    status: row.status as "queued" | "running" | "succeeded" | "failed",
    output: row.output,
    error: row.error,
    exitCode: row.exitCode,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

function remoteAgentHostStatus(
  host: typeof remoteAgentHosts.$inferSelect,
  now: Date,
): RemoteAgentHostStatus {
  if (
    host.status !== "online" ||
    now.getTime() - host.lastSeenAt.getTime() >
      REMOTE_AGENT_HOST_CLOSED_AFTER_MS
  ) {
    return "closed";
  }
  return "online";
}

function serializeHost(row: typeof remoteAgentHosts.$inferSelect, now: Date) {
  return {
    id: row.id,
    displayName: row.displayName,
    supportedBackends: row.supportedBackends as RemoteAgentBackend[],
    status: remoteAgentHostStatus(row, now),
    lastSeenAt: row.lastSeenAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

function serializeRemoteAgentConnector(
  row: typeof connectors.$inferSelect,
): ConnectorResponse {
  return {
    id: row.id,
    type: "remote-agent",
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

async function publishRemoteAgentJobAvailableSafe(
  hostId: string,
  jobId: string,
  signal: AbortSignal,
): Promise<void> {
  const publishResult = await safeAsync(() => {
    return publishRemoteAgentHostJobAvailable(hostId, jobId);
  });
  signal.throwIfAborted();
  if ("error" in publishResult) {
    L.warn("Failed to publish remote-agent job notification", {
      hostId,
      jobId,
      error: publishResult.error,
    });
  }
}

async function publishRemoteAgentHostsChangedSafe(
  userId: string,
  signal: AbortSignal,
): Promise<void> {
  const publishResult = await safeAsync(() => {
    return publishRemoteAgentHostsChanged(userId);
  });
  signal.throwIfAborted();
  if ("error" in publishResult) {
    L.warn("Failed to publish remote-agent host change", {
      userId,
      error: publishResult.error,
    });
  }
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

function chooseJobBackend(
  requestedBackend: string | null,
  supportedBackends: readonly RemoteAgentBackend[],
): RemoteAgentBackend | null {
  if (requestedBackend) {
    const backend = requestedBackend as RemoteAgentBackend;
    return supportedBackends.includes(backend) ? backend : null;
  }
  return supportedBackends[0] ?? null;
}

export const createRemoteAgentDeviceCode$ = command(
  async (
    { set },
    params: {
      readonly hostName: string;
      readonly supportedBackends: readonly RemoteAgentBackend[];
    },
    signal: AbortSignal,
  ): Promise<CreateRemoteAgentDeviceCodeResult> => {
    const writeDb = set(writeDb$);
    const userCode = generateCode();
    const pollToken = generateOpaqueToken("vm0_remote_poll");
    const now = nowDate();
    const expiresAt = new Date(
      now.getTime() + REMOTE_AGENT_DEVICE_CODE_TTL_SECONDS * 1000,
    );

    const [row] = await writeDb
      .insert(remoteAgentDeviceCodes)
      .values({
        codeHash: hashSecret(normalizeDeviceCode(userCode)),
        pollTokenHash: hashSecret(pollToken),
        hostName: normalizeHostName(params.hostName),
        supportedBackends: normalizeBackends(params.supportedBackends),
        status: "pending",
        expiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: remoteAgentDeviceCodes.id });
    signal.throwIfAborted();

    if (!row) {
      throw new Error("Failed to create remote-agent device code");
    }

    let realtime:
      | Awaited<ReturnType<typeof createRemoteAgentDeviceRealtimeSubscription>>
      | undefined;
    const realtimeResult = await safeAsync(() => {
      return createRemoteAgentDeviceRealtimeSubscription(row.id);
    });
    signal.throwIfAborted();
    if ("ok" in realtimeResult) {
      realtime = realtimeResult.ok;
    } else {
      L.warn(
        "Failed to create remote-agent device realtime token",
        realtimeResult.error,
      );
    }

    return {
      deviceCode: userCode,
      userCode,
      verificationPath: REMOTE_AGENT_VERIFICATION_PATH,
      expiresIn: REMOTE_AGENT_DEVICE_CODE_TTL_SECONDS,
      interval: REMOTE_AGENT_POLL_INTERVAL_SECONDS,
      pollToken,
      realtime,
    };
  },
);

export const claimRemoteAgentDeviceCode$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly deviceCode: string;
    },
    signal: AbortSignal,
  ): Promise<ClaimRemoteAgentDeviceCodeResult> => {
    const writeDb = set(writeDb$);
    const now = nowDate();
    const codeHash = hashSecret(normalizeDeviceCode(params.deviceCode));

    const result = await writeDb.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(remoteAgentDeviceCodes)
        .where(eq(remoteAgentDeviceCodes.codeHash, codeHash))
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
          .update(remoteAgentDeviceCodes)
          .set({ status: "expired", updatedAt: now })
          .where(eq(remoteAgentDeviceCodes.id, row.id));
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
        .update(remoteAgentDeviceCodes)
        .set({
          orgId: params.orgId,
          userId: params.userId,
          status: "approved",
          claimedAt: now,
          updatedAt: now,
        })
        .where(eq(remoteAgentDeviceCodes.id, row.id));
      signal.throwIfAborted();

      return {
        status: "approved" as const,
        deviceCodeId: row.id,
      };
    });
    signal.throwIfAborted();

    if (result.status === "approved") {
      await publishRemoteAgentDeviceApproved(result.deviceCodeId);
      signal.throwIfAborted();
      return { status: "approved" as const };
    }

    return result;
  },
);

export const pollRemoteAgentDeviceCode$ = command(
  async (
    { set },
    params: {
      readonly deviceCode: string;
      readonly pollToken: string;
    },
    signal: AbortSignal,
  ): Promise<PollRemoteAgentDeviceCodeResult> => {
    const writeDb = set(writeDb$);
    const now = nowDate();
    const codeHash = hashSecret(normalizeDeviceCode(params.deviceCode));
    const pollTokenHash = hashSecret(params.pollToken);

    const result = await writeDb.transaction(
      async (
        tx,
      ): Promise<PollRemoteAgentDeviceCodeResult & { userId?: string }> => {
        const [row] = await tx
          .select()
          .from(remoteAgentDeviceCodes)
          .where(
            and(
              eq(remoteAgentDeviceCodes.codeHash, codeHash),
              eq(remoteAgentDeviceCodes.pollTokenHash, pollTokenHash),
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
            .update(remoteAgentDeviceCodes)
            .set({ status: "expired", updatedAt: now })
            .where(eq(remoteAgentDeviceCodes.id, row.id));
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

        const hostToken = generateOpaqueToken("vm0_remote_host");
        const [host] = await tx
          .insert(remoteAgentHosts)
          .values({
            orgId: row.orgId,
            userId: row.userId,
            displayName: normalizeHostName(row.hostName),
            tokenHash: hashSecret(hostToken),
            supportedBackends: row.supportedBackends,
            status: "online",
            lastSeenAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: remoteAgentHosts.id });
        signal.throwIfAborted();

        if (!host) {
          throw new Error("Failed to link remote-agent host");
        }

        await tx
          .update(remoteAgentDeviceCodes)
          .set({
            status: "consumed",
            hostId: host.id,
            consumedAt: now,
            updatedAt: now,
          })
          .where(eq(remoteAgentDeviceCodes.id, row.id));
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
      await publishRemoteAgentHostsChangedSafe(result.userId, signal);
      const { userId: _userId, ...publicResult } = result;
      return publicResult;
    }

    return result;
  },
);

export const heartbeatRemoteAgentHost$ = command(
  async (
    { set },
    params: {
      readonly hostToken: string;
      readonly hostName: string;
      readonly supportedBackends: readonly RemoteAgentBackend[];
    },
    signal: AbortSignal,
  ): Promise<{ readonly hostId: string } | null> => {
    const writeDb = set(writeDb$);
    const now = nowDate();
    const [existing] = await writeDb
      .select()
      .from(remoteAgentHosts)
      .where(
        and(
          eq(remoteAgentHosts.tokenHash, hashSecret(params.hostToken)),
          isNull(remoteAgentHosts.revokedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!existing) {
      return null;
    }

    const wasOnline = remoteAgentHostStatus(existing, now) === "online";
    const [row] = await writeDb
      .update(remoteAgentHosts)
      .set({
        displayName: normalizeHostName(params.hostName),
        supportedBackends: normalizeBackends(params.supportedBackends),
        status: "online",
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(eq(remoteAgentHosts.id, existing.id))
      .returning({ id: remoteAgentHosts.id, userId: remoteAgentHosts.userId });
    signal.throwIfAborted();

    if (!row) {
      return null;
    }

    if (!wasOnline) {
      await publishRemoteAgentHostsChangedSafe(row.userId, signal);
    }

    return { hostId: row.id };
  },
);

export const createRemoteAgentHostRealtimeToken$ = command(
  async (
    { set },
    params: {
      readonly hostToken: string;
    },
    signal: AbortSignal,
  ) => {
    const writeDb = set(writeDb$);
    const [host] = await writeDb
      .select({ id: remoteAgentHosts.id })
      .from(remoteAgentHosts)
      .where(
        and(
          eq(remoteAgentHosts.tokenHash, hashSecret(params.hostToken)),
          isNull(remoteAgentHosts.revokedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!host) {
      return null;
    }

    return await createRemoteAgentHostRealtimeSubscription(host.id);
  },
);

export const listRemoteAgentHosts$ = command(
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
      .from(remoteAgentHosts)
      .where(
        and(
          eq(remoteAgentHosts.orgId, params.orgId),
          eq(remoteAgentHosts.userId, params.userId),
          isNull(remoteAgentHosts.revokedAt),
        ),
      )
      .orderBy(desc(remoteAgentHosts.lastSeenAt));
    signal.throwIfAborted();

    return {
      hosts: rows.map((row) => {
        return serializeHost(row, now);
      }),
    };
  },
);

export const connectRemoteAgentConnector$ = command(
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
      .from(remoteAgentHosts)
      .where(
        and(
          eq(remoteAgentHosts.orgId, params.orgId),
          eq(remoteAgentHosts.userId, params.userId),
          isNull(remoteAgentHosts.revokedAt),
        ),
      );
    signal.throwIfAborted();

    const hasOnlineHost = hostRows.some((host) => {
      return remoteAgentHostStatus(host, now) === "online";
    });
    if (!hasOnlineHost) {
      return { status: "no_online_host" as const };
    }

    const [row] = await writeDb
      .insert(connectors)
      .values({
        type: "remote-agent",
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
      throw new Error("Failed to connect remote-agent connector");
    }

    await publishConnectorChangedSafe(params.userId, signal);

    return {
      status: "connected" as const,
      connector: serializeRemoteAgentConnector(row),
    };
  },
);

export const startRemoteAgentHost$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly hostName: string;
      readonly supportedBackends: readonly RemoteAgentBackend[];
      readonly hostId?: string;
    },
    signal: AbortSignal,
  ) => {
    const writeDb = set(writeDb$);
    const now = nowDate();
    const hostToken = generateOpaqueToken("vm0_remote_host");
    const values = {
      displayName: normalizeHostName(params.hostName),
      tokenHash: hashSecret(hostToken),
      supportedBackends: normalizeBackends(params.supportedBackends),
      status: "online",
      lastSeenAt: now,
      updatedAt: now,
    };

    if (params.hostId) {
      const [host] = await writeDb
        .update(remoteAgentHosts)
        .set(values)
        .where(
          and(
            eq(remoteAgentHosts.id, params.hostId),
            eq(remoteAgentHosts.orgId, params.orgId),
            eq(remoteAgentHosts.userId, params.userId),
            isNull(remoteAgentHosts.revokedAt),
          ),
        )
        .returning({ id: remoteAgentHosts.id });
      signal.throwIfAborted();

      if (!host) {
        return { status: "not_found" as const };
      }

      await publishRemoteAgentHostsChangedSafe(params.userId, signal);

      return {
        status: "started" as const,
        hostId: host.id,
        hostToken,
      };
    }

    const [host] = await writeDb
      .insert(remoteAgentHosts)
      .values({
        orgId: params.orgId,
        userId: params.userId,
        ...values,
        createdAt: now,
      })
      .returning({ id: remoteAgentHosts.id });
    signal.throwIfAborted();

    if (!host) {
      throw new Error("Failed to start remote-agent host");
    }

    await publishRemoteAgentHostsChangedSafe(params.userId, signal);

    return {
      status: "started" as const,
      hostId: host.id,
      hostToken,
    };
  },
);

export const deleteRemoteAgentHost$ = command(
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
        .update(remoteAgentHosts)
        .set({
          status: "offline",
          revokedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(remoteAgentHosts.id, params.hostId),
            eq(remoteAgentHosts.orgId, params.orgId),
            eq(remoteAgentHosts.userId, params.userId),
            isNull(remoteAgentHosts.revokedAt),
          ),
        )
        .returning({ id: remoteAgentHosts.id });
      signal.throwIfAborted();

      if (!host) {
        return { status: "not_found" as const };
      }

      await tx
        .update(remoteAgentJobs)
        .set({
          status: "failed",
          error: "Remote-agent host was deleted",
          exitCode: 1,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(remoteAgentJobs.hostId, host.id),
            inArray(remoteAgentJobs.status, ["queued", "running"]),
          ),
        );
      signal.throwIfAborted();

      return { status: "deleted" as const };
    });
    signal.throwIfAborted();

    if (result.status === "deleted") {
      await publishRemoteAgentHostsChangedSafe(params.userId, signal);
    }

    return result;
  },
);

export const createRemoteAgentJob$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly prompt: string;
      readonly hostName?: string;
    },
    signal: AbortSignal,
  ) => {
    const writeDb = set(writeDb$);
    const hosts = await writeDb
      .select()
      .from(remoteAgentHosts)
      .where(
        and(
          eq(remoteAgentHosts.orgId, params.orgId),
          eq(remoteAgentHosts.userId, params.userId),
          isNull(remoteAgentHosts.revokedAt),
        ),
      )
      .orderBy(desc(remoteAgentHosts.lastSeenAt));
    signal.throwIfAborted();

    if (hosts.length === 0) {
      return { status: "no_host" as const };
    }

    if (params.hostName) {
      const matchingHosts = hosts.filter((row) => {
        return row.displayName === params.hostName;
      });
      if (matchingHosts.length > 1) {
        return { status: "host_ambiguous" as const };
      }
      const host = matchingHosts[0];
      if (!host) {
        return { status: "host_not_found" as const };
      }
      if (remoteAgentHostStatus(host, nowDate()) !== "online") {
        return { status: "host_closed" as const };
      }

      const now = nowDate();
      const [job] = await writeDb
        .insert(remoteAgentJobs)
        .values({
          orgId: params.orgId,
          userId: params.userId,
          hostId: host.id,
          prompt: params.prompt,
          status: "queued",
          createdAt: now,
          updatedAt: now,
        })
        .returning({
          id: remoteAgentJobs.id,
          status: remoteAgentJobs.status,
        });
      signal.throwIfAborted();

      if (!job) {
        throw new Error("Failed to create remote-agent job");
      }

      await publishRemoteAgentJobAvailableSafe(host.id, job.id, signal);

      return {
        status: "created" as const,
        jobId: job.id,
        jobStatus: job.status as "queued",
      };
    }

    const now = nowDate();
    const onlineHosts = hosts.filter((host) => {
      return remoteAgentHostStatus(host, now) === "online";
    });
    if (onlineHosts.length === 0) {
      return { status: "host_closed" as const };
    }

    const [job] = await writeDb
      .insert(remoteAgentJobs)
      .values({
        orgId: params.orgId,
        userId: params.userId,
        prompt: params.prompt,
        status: "queued",
        createdAt: now,
        updatedAt: now,
      })
      .returning({
        id: remoteAgentJobs.id,
        status: remoteAgentJobs.status,
      });
    signal.throwIfAborted();

    if (!job) {
      throw new Error("Failed to create remote-agent job");
    }

    for (const host of onlineHosts) {
      await publishRemoteAgentJobAvailableSafe(host.id, job.id, signal);
    }

    return {
      status: "created" as const,
      jobId: job.id,
      jobStatus: job.status as "queued",
    };
  },
);

export const getRemoteAgentJob$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly jobId: string;
    },
    signal: AbortSignal,
  ) => {
    const writeDb = set(writeDb$);
    const [row] = await writeDb
      .select()
      .from(remoteAgentJobs)
      .where(
        and(
          eq(remoteAgentJobs.id, params.jobId),
          eq(remoteAgentJobs.orgId, params.orgId),
          eq(remoteAgentJobs.userId, params.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    return row ? serializeJob(row) : null;
  },
);

export const claimNextRemoteAgentHostJob$ = command(
  async (
    { set },
    params: {
      readonly hostToken: string;
      readonly supportedBackends: readonly RemoteAgentBackend[];
    },
    signal: AbortSignal,
  ) => {
    const writeDb = set(writeDb$);
    const now = nowDate();
    const supportedBackends = normalizeBackends(params.supportedBackends);
    return await writeDb.transaction(async (tx) => {
      const [host] = await tx
        .select()
        .from(remoteAgentHosts)
        .where(
          and(
            eq(remoteAgentHosts.tokenHash, hashSecret(params.hostToken)),
            isNull(remoteAgentHosts.revokedAt),
          ),
        )
        .limit(1);
      signal.throwIfAborted();

      if (!host) {
        return { status: "invalid_token" as const };
      }

      await tx
        .update(remoteAgentHosts)
        .set({
          supportedBackends,
          status: "online",
          lastSeenAt: now,
          updatedAt: now,
        })
        .where(eq(remoteAgentHosts.id, host.id));
      signal.throwIfAborted();

      const rows = await tx
        .select()
        .from(remoteAgentJobs)
        .where(
          and(
            eq(remoteAgentJobs.orgId, host.orgId),
            eq(remoteAgentJobs.userId, host.userId),
            eq(remoteAgentJobs.status, "queued"),
            or(
              isNull(remoteAgentJobs.hostId),
              eq(remoteAgentJobs.hostId, host.id),
            ),
            or(
              isNull(remoteAgentJobs.backend),
              inArray(remoteAgentJobs.backend, supportedBackends),
            ),
          ),
        )
        .orderBy(asc(remoteAgentJobs.createdAt))
        .for("update")
        .limit(1);
      signal.throwIfAborted();

      const job = rows[0];
      if (!job) {
        return { status: "idle" as const };
      }

      const backend = chooseJobBackend(job.backend, supportedBackends);
      if (!backend) {
        return { status: "idle" as const };
      }

      const [claimedJob] = await tx
        .update(remoteAgentJobs)
        .set({
          hostId: host.id,
          backend,
          status: "running",
          startedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(remoteAgentJobs.id, job.id),
            eq(remoteAgentJobs.status, "queued"),
            or(
              isNull(remoteAgentJobs.hostId),
              eq(remoteAgentJobs.hostId, host.id),
            ),
          ),
        )
        .returning({
          id: remoteAgentJobs.id,
          prompt: remoteAgentJobs.prompt,
        });
      signal.throwIfAborted();

      if (!claimedJob) {
        return { status: "idle" as const };
      }

      return {
        status: "job" as const,
        job: {
          id: claimedJob.id,
          backend,
          prompt: claimedJob.prompt,
        },
      };
    });
  },
);

export const completeRemoteAgentHostJob$ = command(
  async (
    { set },
    params: {
      readonly hostToken: string;
      readonly jobId: string;
      readonly status: "succeeded" | "failed";
      readonly output?: string;
      readonly error?: string;
      readonly exitCode?: number;
    },
    signal: AbortSignal,
  ) => {
    const writeDb = set(writeDb$);
    const now = nowDate();
    return await writeDb.transaction(async (tx) => {
      const [host] = await tx
        .select()
        .from(remoteAgentHosts)
        .where(
          and(
            eq(remoteAgentHosts.tokenHash, hashSecret(params.hostToken)),
            isNull(remoteAgentHosts.revokedAt),
          ),
        )
        .limit(1);
      signal.throwIfAborted();

      if (!host) {
        return { status: "invalid_token" as const };
      }

      const [job] = await tx
        .select()
        .from(remoteAgentJobs)
        .where(
          and(
            eq(remoteAgentJobs.id, params.jobId),
            eq(remoteAgentJobs.hostId, host.id),
          ),
        )
        .for("update")
        .limit(1);
      signal.throwIfAborted();

      if (!job) {
        return { status: "not_found" as const };
      }
      if (job.status !== "running") {
        return { status: "not_running" as const };
      }

      await tx
        .update(remoteAgentJobs)
        .set({
          status: params.status,
          output: params.output,
          error: params.error,
          exitCode: params.exitCode ?? (params.status === "succeeded" ? 0 : 1),
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(remoteAgentJobs.id, job.id));
      signal.throwIfAborted();

      return { status: "completed" as const };
    });
  },
);
