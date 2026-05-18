import { createHash, randomBytes, randomInt } from "crypto";
import { command } from "ccstate";
import { and, asc, desc, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import type {
  LocalAgentBackend,
  LocalAgentHostStatus,
} from "@vm0/api-contracts/contracts/zero-local-agent";
import { connectors } from "@vm0/db/schema/connector";
import {
  localAgentDeviceCodes,
  localAgentHosts,
  localAgentJobs,
} from "@vm0/db/schema/local-agent";

import { writeDb$ } from "../external/db";
import { nowDate } from "../external/time";
import {
  createLocalAgentDeviceRealtimeSubscription,
  createLocalAgentHostRealtimeSubscription,
  publishLocalAgentDeviceApproved,
  publishLocalAgentHostsChanged,
  publishLocalAgentHostJobAvailable,
  publishUserSignal,
} from "../external/realtime";
import { settle } from "../utils";
import { logger } from "../../lib/log";

const LOCAL_AGENT_DEVICE_CODE_TTL_SECONDS = 15 * 60;
const LOCAL_AGENT_POLL_INTERVAL_SECONDS = 5;
const LOCAL_AGENT_HOST_CLOSED_AFTER_MS = 90 * 1000;
const LOCAL_AGENT_VERIFICATION_PATH = "/zero/connectors/local-agent";
const L = logger("ZeroLocalAgent");

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

interface CreateLocalAgentDeviceCodeResult {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationPath: string;
  readonly expiresIn: number;
  readonly interval: number;
  readonly pollToken: string;
  readonly realtime?: Awaited<
    ReturnType<typeof createLocalAgentDeviceRealtimeSubscription>
  >;
}

type ClaimLocalAgentDeviceCodeResult =
  | { readonly status: "approved" }
  | { readonly status: "not_found" }
  | { readonly status: "expired" }
  | { readonly status: "already_claimed" };

type PollLocalAgentDeviceCodeResult =
  | { readonly status: "pending" }
  | {
      readonly status: "linked";
      readonly hostId: string;
      readonly hostToken?: string;
    }
  | { readonly status: "expired" }
  | { readonly status: "invalid" };

type LocalAgentJobStatus = "queued" | "running" | "succeeded" | "failed";

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
  backends: readonly LocalAgentBackend[],
): LocalAgentBackend[] {
  return [...new Set(backends)];
}

function normalizeHostName(hostName: string): string {
  return hostName.trim().slice(0, 128);
}

function hasExpired(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() <= now.getTime();
}

function serializeJob(row: typeof localAgentJobs.$inferSelect) {
  return {
    id: row.id,
    hostId: row.hostId,
    backend: row.backend as LocalAgentBackend | null,
    prompt: row.prompt,
    status: row.status as LocalAgentJobStatus,
    output: row.output,
    error: row.error,
    exitCode: row.exitCode,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

function serializeJobListItem(row: {
  readonly job: typeof localAgentJobs.$inferSelect;
  readonly hostName: string | null;
}) {
  return {
    id: row.job.id,
    hostId: row.job.hostId,
    hostName: row.hostName,
    backend: row.job.backend as LocalAgentBackend | null,
    prompt: row.job.prompt,
    status: row.job.status as LocalAgentJobStatus,
    exitCode: row.job.exitCode,
    createdAt: row.job.createdAt.toISOString(),
    startedAt: row.job.startedAt?.toISOString() ?? null,
    completedAt: row.job.completedAt?.toISOString() ?? null,
  };
}

function localAgentHostStatus(
  host: typeof localAgentHosts.$inferSelect,
  now: Date,
): LocalAgentHostStatus {
  if (
    host.status !== "online" ||
    now.getTime() - host.lastSeenAt.getTime() > LOCAL_AGENT_HOST_CLOSED_AFTER_MS
  ) {
    return "closed";
  }
  return "online";
}

function serializeHost(row: typeof localAgentHosts.$inferSelect, now: Date) {
  return {
    id: row.id,
    displayName: row.displayName,
    supportedBackends: row.supportedBackends as LocalAgentBackend[],
    status: localAgentHostStatus(row, now),
    lastSeenAt: row.lastSeenAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

function serializeLocalAgentConnector(
  row: typeof connectors.$inferSelect,
): ConnectorResponse {
  return {
    id: row.id,
    type: "local-agent",
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

async function publishLocalAgentJobAvailableSafe(
  hostId: string,
  jobId: string,
  signal: AbortSignal,
): Promise<void> {
  const publishResult = await settle(
    publishLocalAgentHostJobAvailable(hostId, jobId),
  );
  signal.throwIfAborted();
  if (!publishResult.ok) {
    L.warn("Failed to publish local-agent job notification", {
      hostId,
      jobId,
      error: publishResult.error,
    });
  }
}

async function publishLocalAgentHostsChangedSafe(
  userId: string,
  signal: AbortSignal,
): Promise<void> {
  const publishResult = await settle(publishLocalAgentHostsChanged(userId));
  signal.throwIfAborted();
  if (!publishResult.ok) {
    L.warn("Failed to publish local-agent host change", {
      userId,
      error: publishResult.error,
    });
  }
}

async function publishConnectorChangedSafe(
  userId: string,
  signal: AbortSignal,
): Promise<void> {
  const publishResult = await settle(
    publishUserSignal([userId], "connector:changed"),
  );
  signal.throwIfAborted();
  if (!publishResult.ok) {
    L.warn("Failed to publish connector change", {
      userId,
      error: publishResult.error,
    });
  }
}

function chooseJobBackend(
  requestedBackend: string | null,
  supportedBackends: readonly LocalAgentBackend[],
): LocalAgentBackend | null {
  if (requestedBackend) {
    const backend = requestedBackend as LocalAgentBackend;
    return supportedBackends.includes(backend) ? backend : null;
  }
  return supportedBackends[0] ?? null;
}

export const createLocalAgentDeviceCode$ = command(
  async (
    { set },
    params: {
      readonly hostName: string;
      readonly supportedBackends: readonly LocalAgentBackend[];
    },
    signal: AbortSignal,
  ): Promise<CreateLocalAgentDeviceCodeResult> => {
    const writeDb = set(writeDb$);
    const userCode = generateCode();
    const pollToken = generateOpaqueToken("vm0_remote_poll");
    const now = nowDate();
    const expiresAt = new Date(
      now.getTime() + LOCAL_AGENT_DEVICE_CODE_TTL_SECONDS * 1000,
    );

    const [row] = await writeDb
      .insert(localAgentDeviceCodes)
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
      .returning({ id: localAgentDeviceCodes.id });
    signal.throwIfAborted();

    if (!row) {
      throw new Error("Failed to create local-agent device code");
    }

    let realtime:
      | Awaited<ReturnType<typeof createLocalAgentDeviceRealtimeSubscription>>
      | undefined;
    const realtimeResult = await settle(
      createLocalAgentDeviceRealtimeSubscription(row.id),
    );
    signal.throwIfAborted();
    if (realtimeResult.ok) {
      realtime = realtimeResult.value;
    } else {
      L.warn(
        "Failed to create local-agent device realtime token",
        realtimeResult.error,
      );
    }

    return {
      deviceCode: userCode,
      userCode,
      verificationPath: LOCAL_AGENT_VERIFICATION_PATH,
      expiresIn: LOCAL_AGENT_DEVICE_CODE_TTL_SECONDS,
      interval: LOCAL_AGENT_POLL_INTERVAL_SECONDS,
      pollToken,
      realtime,
    };
  },
);

export const claimLocalAgentDeviceCode$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly deviceCode: string;
    },
    signal: AbortSignal,
  ): Promise<ClaimLocalAgentDeviceCodeResult> => {
    const writeDb = set(writeDb$);
    const now = nowDate();
    const codeHash = hashSecret(normalizeDeviceCode(params.deviceCode));

    const result = await writeDb.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(localAgentDeviceCodes)
        .where(eq(localAgentDeviceCodes.codeHash, codeHash))
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
          .update(localAgentDeviceCodes)
          .set({ status: "expired", updatedAt: now })
          .where(eq(localAgentDeviceCodes.id, row.id));
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
        .update(localAgentDeviceCodes)
        .set({
          orgId: params.orgId,
          userId: params.userId,
          status: "approved",
          claimedAt: now,
          updatedAt: now,
        })
        .where(eq(localAgentDeviceCodes.id, row.id));
      signal.throwIfAborted();

      return {
        status: "approved" as const,
        deviceCodeId: row.id,
      };
    });
    signal.throwIfAborted();

    if (result.status === "approved") {
      await publishLocalAgentDeviceApproved(result.deviceCodeId);
      signal.throwIfAborted();
      return { status: "approved" as const };
    }

    return result;
  },
);

export const pollLocalAgentDeviceCode$ = command(
  async (
    { set },
    params: {
      readonly deviceCode: string;
      readonly pollToken: string;
    },
    signal: AbortSignal,
  ): Promise<PollLocalAgentDeviceCodeResult> => {
    const writeDb = set(writeDb$);
    const now = nowDate();
    const codeHash = hashSecret(normalizeDeviceCode(params.deviceCode));
    const pollTokenHash = hashSecret(params.pollToken);

    const result = await writeDb.transaction(
      async (
        tx,
      ): Promise<PollLocalAgentDeviceCodeResult & { userId?: string }> => {
        const [row] = await tx
          .select()
          .from(localAgentDeviceCodes)
          .where(
            and(
              eq(localAgentDeviceCodes.codeHash, codeHash),
              eq(localAgentDeviceCodes.pollTokenHash, pollTokenHash),
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
            .update(localAgentDeviceCodes)
            .set({ status: "expired", updatedAt: now })
            .where(eq(localAgentDeviceCodes.id, row.id));
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
          .insert(localAgentHosts)
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
          .returning({ id: localAgentHosts.id });
        signal.throwIfAborted();

        if (!host) {
          throw new Error("Failed to link local-agent host");
        }

        await tx
          .update(localAgentDeviceCodes)
          .set({
            status: "consumed",
            hostId: host.id,
            consumedAt: now,
            updatedAt: now,
          })
          .where(eq(localAgentDeviceCodes.id, row.id));
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
      await publishLocalAgentHostsChangedSafe(result.userId, signal);
      const { userId: _userId, ...publicResult } = result;
      return publicResult;
    }

    return result;
  },
);

export const heartbeatLocalAgentHost$ = command(
  async (
    { set },
    params: {
      readonly hostToken: string;
      readonly hostName: string;
      readonly supportedBackends: readonly LocalAgentBackend[];
    },
    signal: AbortSignal,
  ): Promise<{ readonly hostId: string } | null> => {
    const writeDb = set(writeDb$);
    const now = nowDate();
    const [existing] = await writeDb
      .select()
      .from(localAgentHosts)
      .where(
        and(
          eq(localAgentHosts.tokenHash, hashSecret(params.hostToken)),
          isNull(localAgentHosts.revokedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!existing) {
      return null;
    }

    const wasOnline = localAgentHostStatus(existing, now) === "online";
    const [row] = await writeDb
      .update(localAgentHosts)
      .set({
        displayName: normalizeHostName(params.hostName),
        supportedBackends: normalizeBackends(params.supportedBackends),
        status: "online",
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(eq(localAgentHosts.id, existing.id))
      .returning({ id: localAgentHosts.id, userId: localAgentHosts.userId });
    signal.throwIfAborted();

    if (!row) {
      return null;
    }

    if (!wasOnline) {
      await publishLocalAgentHostsChangedSafe(row.userId, signal);
    }

    return { hostId: row.id };
  },
);

export const closeLocalAgentHost$ = command(
  async (
    { set },
    params: {
      readonly hostToken: string;
    },
    signal: AbortSignal,
  ): Promise<{ readonly hostId: string } | null> => {
    const writeDb = set(writeDb$);
    const now = nowDate();
    const [existing] = await writeDb
      .select()
      .from(localAgentHosts)
      .where(
        and(
          eq(localAgentHosts.tokenHash, hashSecret(params.hostToken)),
          isNull(localAgentHosts.revokedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!existing) {
      return null;
    }

    const wasOnline = localAgentHostStatus(existing, now) === "online";
    const [row] = await writeDb
      .update(localAgentHosts)
      .set({
        status: "closed",
        updatedAt: now,
      })
      .where(
        and(
          eq(localAgentHosts.id, existing.id),
          isNull(localAgentHosts.revokedAt),
        ),
      )
      .returning({ id: localAgentHosts.id, userId: localAgentHosts.userId });
    signal.throwIfAborted();

    if (!row) {
      return null;
    }

    if (wasOnline) {
      await publishLocalAgentHostsChangedSafe(row.userId, signal);
    }

    return { hostId: row.id };
  },
);

export const createLocalAgentHostRealtimeToken$ = command(
  async (
    { set },
    params: {
      readonly hostToken: string;
    },
    signal: AbortSignal,
  ) => {
    const writeDb = set(writeDb$);
    const [host] = await writeDb
      .select({ id: localAgentHosts.id })
      .from(localAgentHosts)
      .where(
        and(
          eq(localAgentHosts.tokenHash, hashSecret(params.hostToken)),
          isNull(localAgentHosts.revokedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!host) {
      return null;
    }

    return await createLocalAgentHostRealtimeSubscription(host.id);
  },
);

export const listLocalAgentHosts$ = command(
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
      .from(localAgentHosts)
      .where(
        and(
          eq(localAgentHosts.orgId, params.orgId),
          eq(localAgentHosts.userId, params.userId),
          isNull(localAgentHosts.revokedAt),
        ),
      )
      .orderBy(desc(localAgentHosts.lastSeenAt));
    signal.throwIfAborted();

    return {
      hosts: rows.map((row) => {
        return serializeHost(row, now);
      }),
    };
  },
);

export const connectLocalAgentConnector$ = command(
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
      .from(localAgentHosts)
      .where(
        and(
          eq(localAgentHosts.orgId, params.orgId),
          eq(localAgentHosts.userId, params.userId),
          isNull(localAgentHosts.revokedAt),
        ),
      );
    signal.throwIfAborted();

    const hasOnlineHost = hostRows.some((host) => {
      return localAgentHostStatus(host, now) === "online";
    });
    if (!hasOnlineHost) {
      return { status: "no_online_host" as const };
    }

    const [row] = await writeDb
      .insert(connectors)
      .values({
        type: "local-agent",
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
      throw new Error("Failed to connect local-agent connector");
    }

    await publishConnectorChangedSafe(params.userId, signal);

    return {
      status: "connected" as const,
      connector: serializeLocalAgentConnector(row),
    };
  },
);

export const startLocalAgentHost$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly hostName: string;
      readonly supportedBackends: readonly LocalAgentBackend[];
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
        .update(localAgentHosts)
        .set(values)
        .where(
          and(
            eq(localAgentHosts.id, params.hostId),
            eq(localAgentHosts.orgId, params.orgId),
            eq(localAgentHosts.userId, params.userId),
            isNull(localAgentHosts.revokedAt),
          ),
        )
        .returning({ id: localAgentHosts.id });
      signal.throwIfAborted();

      if (!host) {
        return { status: "not_found" as const };
      }

      await publishLocalAgentHostsChangedSafe(params.userId, signal);

      return {
        status: "started" as const,
        hostId: host.id,
        hostToken,
      };
    }

    const [host] = await writeDb
      .insert(localAgentHosts)
      .values({
        orgId: params.orgId,
        userId: params.userId,
        ...values,
        createdAt: now,
      })
      .returning({ id: localAgentHosts.id });
    signal.throwIfAborted();

    if (!host) {
      throw new Error("Failed to start local-agent host");
    }

    await publishLocalAgentHostsChangedSafe(params.userId, signal);

    return {
      status: "started" as const,
      hostId: host.id,
      hostToken,
    };
  },
);

export const deleteLocalAgentHost$ = command(
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
        .update(localAgentHosts)
        .set({
          status: "offline",
          revokedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(localAgentHosts.id, params.hostId),
            eq(localAgentHosts.orgId, params.orgId),
            eq(localAgentHosts.userId, params.userId),
            isNull(localAgentHosts.revokedAt),
          ),
        )
        .returning({ id: localAgentHosts.id });
      signal.throwIfAborted();

      if (!host) {
        return { status: "not_found" as const };
      }

      await tx
        .update(localAgentJobs)
        .set({
          status: "failed",
          error: "Local-agent host was deleted",
          exitCode: 1,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(localAgentJobs.hostId, host.id),
            inArray(localAgentJobs.status, ["queued", "running"]),
          ),
        );
      signal.throwIfAborted();

      return { status: "deleted" as const };
    });
    signal.throwIfAborted();

    if (result.status === "deleted") {
      await publishLocalAgentHostsChangedSafe(params.userId, signal);
    }

    return result;
  },
);

export const createLocalAgentJob$ = command(
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
      .from(localAgentHosts)
      .where(
        and(
          eq(localAgentHosts.orgId, params.orgId),
          eq(localAgentHosts.userId, params.userId),
          isNull(localAgentHosts.revokedAt),
        ),
      )
      .orderBy(desc(localAgentHosts.lastSeenAt));
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
      if (localAgentHostStatus(host, nowDate()) !== "online") {
        return { status: "host_closed" as const };
      }

      const now = nowDate();
      const [job] = await writeDb
        .insert(localAgentJobs)
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
          id: localAgentJobs.id,
          status: localAgentJobs.status,
        });
      signal.throwIfAborted();

      if (!job) {
        throw new Error("Failed to create local-agent job");
      }

      await publishLocalAgentJobAvailableSafe(host.id, job.id, signal);

      return {
        status: "created" as const,
        jobId: job.id,
        jobStatus: job.status as "queued",
      };
    }

    const now = nowDate();
    const onlineHosts = hosts.filter((host) => {
      return localAgentHostStatus(host, now) === "online";
    });
    if (onlineHosts.length === 0) {
      return { status: "host_closed" as const };
    }

    const [job] = await writeDb
      .insert(localAgentJobs)
      .values({
        orgId: params.orgId,
        userId: params.userId,
        prompt: params.prompt,
        status: "queued",
        createdAt: now,
        updatedAt: now,
      })
      .returning({
        id: localAgentJobs.id,
        status: localAgentJobs.status,
      });
    signal.throwIfAborted();

    if (!job) {
      throw new Error("Failed to create local-agent job");
    }

    for (const host of onlineHosts) {
      await publishLocalAgentJobAvailableSafe(host.id, job.id, signal);
    }

    return {
      status: "created" as const,
      jobId: job.id,
      jobStatus: job.status as "queued",
    };
  },
);

export const getLocalAgentJob$ = command(
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
      .from(localAgentJobs)
      .where(
        and(
          eq(localAgentJobs.id, params.jobId),
          eq(localAgentJobs.orgId, params.orgId),
          eq(localAgentJobs.userId, params.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    return row ? serializeJob(row) : null;
  },
);

export const listLocalAgentJobs$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly status?: LocalAgentJobStatus;
      readonly hostId?: string;
      readonly hostName?: string;
      readonly limit: number;
    },
    signal: AbortSignal,
  ) => {
    const writeDb = set(writeDb$);
    const conditions: SQL[] = [
      eq(localAgentJobs.orgId, params.orgId),
      eq(localAgentJobs.userId, params.userId),
    ];

    if (params.status) {
      conditions.push(eq(localAgentJobs.status, params.status));
    }
    if (params.hostId) {
      conditions.push(eq(localAgentJobs.hostId, params.hostId));
    }
    if (params.hostName) {
      conditions.push(eq(localAgentHosts.displayName, params.hostName));
    }

    const rows = await writeDb
      .select({
        job: localAgentJobs,
        hostName: localAgentHosts.displayName,
      })
      .from(localAgentJobs)
      .leftJoin(localAgentHosts, eq(localAgentJobs.hostId, localAgentHosts.id))
      .where(and(...conditions))
      .orderBy(desc(localAgentJobs.createdAt))
      .limit(params.limit);
    signal.throwIfAborted();

    return {
      runs: rows.map((row) => {
        return serializeJobListItem(row);
      }),
    };
  },
);

export const claimNextLocalAgentHostJob$ = command(
  async (
    { set },
    params: {
      readonly hostToken: string;
      readonly supportedBackends: readonly LocalAgentBackend[];
    },
    signal: AbortSignal,
  ) => {
    const writeDb = set(writeDb$);
    const now = nowDate();
    const supportedBackends = normalizeBackends(params.supportedBackends);
    return await writeDb.transaction(async (tx) => {
      const [host] = await tx
        .select()
        .from(localAgentHosts)
        .where(
          and(
            eq(localAgentHosts.tokenHash, hashSecret(params.hostToken)),
            isNull(localAgentHosts.revokedAt),
          ),
        )
        .limit(1);
      signal.throwIfAborted();

      if (!host) {
        return { status: "invalid_token" as const };
      }

      await tx
        .update(localAgentHosts)
        .set({
          supportedBackends,
          status: "online",
          lastSeenAt: now,
          updatedAt: now,
        })
        .where(eq(localAgentHosts.id, host.id));
      signal.throwIfAborted();

      const rows = await tx
        .select()
        .from(localAgentJobs)
        .where(
          and(
            eq(localAgentJobs.orgId, host.orgId),
            eq(localAgentJobs.userId, host.userId),
            eq(localAgentJobs.status, "queued"),
            or(
              isNull(localAgentJobs.hostId),
              eq(localAgentJobs.hostId, host.id),
            ),
            or(
              isNull(localAgentJobs.backend),
              inArray(localAgentJobs.backend, supportedBackends),
            ),
          ),
        )
        .orderBy(asc(localAgentJobs.createdAt))
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
        .update(localAgentJobs)
        .set({
          hostId: host.id,
          backend,
          status: "running",
          startedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(localAgentJobs.id, job.id),
            eq(localAgentJobs.status, "queued"),
            or(
              isNull(localAgentJobs.hostId),
              eq(localAgentJobs.hostId, host.id),
            ),
          ),
        )
        .returning({
          id: localAgentJobs.id,
          prompt: localAgentJobs.prompt,
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

export const completeLocalAgentHostJob$ = command(
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
        .from(localAgentHosts)
        .where(
          and(
            eq(localAgentHosts.tokenHash, hashSecret(params.hostToken)),
            isNull(localAgentHosts.revokedAt),
          ),
        )
        .limit(1);
      signal.throwIfAborted();

      if (!host) {
        return { status: "invalid_token" as const };
      }

      const [job] = await tx
        .select()
        .from(localAgentJobs)
        .where(
          and(
            eq(localAgentJobs.id, params.jobId),
            eq(localAgentJobs.hostId, host.id),
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
        .update(localAgentJobs)
        .set({
          status: params.status,
          output: params.output,
          error: params.error,
          exitCode: params.exitCode ?? (params.status === "succeeded" ? 0 : 1),
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(localAgentJobs.id, job.id));
      signal.throwIfAborted();

      return { status: "completed" as const };
    });
  },
);
