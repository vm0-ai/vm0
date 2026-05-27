import { createHash, randomBytes } from "node:crypto";

import { command } from "ccstate";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type {
  ComputerUseCommandError,
  ComputerUseCommandKind,
  ComputerUseCommandResult,
  ComputerUseCommandStatus,
  ComputerUseReadCommandKind,
  ComputerUseWriteCommandKind,
} from "@vm0/api-contracts/contracts/zero-computer-use";
import {
  computerUseCommandAuditEvents,
  computerUseCommands,
  computerUseHosts,
} from "@vm0/db/schema/computer-use-host";

import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";

const COMPUTER_USE_HOST_CLOSED_AFTER_MS = 90 * 1000;
const L = logger("ZeroComputerUse");

const COMPUTER_USE_READ_COMMANDS = [
  "apps.list",
  "app.state",
] as const satisfies readonly ComputerUseReadCommandKind[];
const COMPUTER_USE_WRITE_COMMANDS = [
  "app.open",
  "element.click",
  "element.scroll",
  "element.set_value",
  "element.perform_action",
  "keyboard.type_text",
  "keyboard.press_key",
] as const satisfies readonly ComputerUseWriteCommandKind[];
const COMPUTER_USE_COMMANDS = [
  ...COMPUTER_USE_READ_COMMANDS,
  ...COMPUTER_USE_WRITE_COMMANDS,
] as const satisfies readonly ComputerUseCommandKind[];

type ComputerUseTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type ComputerUseHostRow = typeof computerUseHosts.$inferSelect;
type ComputerUseCommandRow = typeof computerUseCommands.$inferSelect;

interface ComputerUseCommandPayload {
  readonly app?: string;
  readonly snapshotId?: string;
  readonly elementId?: string;
  readonly elementIndex?: number;
  readonly x?: number;
  readonly y?: number;
  readonly button?: "left" | "right" | "middle";
  readonly clickCount?: number;
  readonly direction?: "up" | "down" | "left" | "right";
  readonly pages?: number;
  readonly value?: string;
  readonly text?: string;
  readonly key?: string;
  readonly action?: string;
}

type CreateComputerUseCommandResult =
  | {
      readonly status: "created";
      readonly commandId: string;
      readonly commandStatus: "queued" | "pending_approval";
    }
  | { readonly status: "no_host" }
  | { readonly status: "host_ambiguous" }
  | { readonly status: "host_offline" }
  | { readonly status: "host_unsupported" };

type ApproveComputerUseWriteCommandResult =
  | { readonly status: "approved"; readonly commandId: string }
  | { readonly status: "denied"; readonly commandId: string }
  | { readonly status: "not_found" }
  | { readonly status: "not_pending" };

type ResolveComputerUseCommandTargetsResult =
  | {
      readonly status: "resolved";
      readonly targetHostId: string;
      readonly notifyHosts: readonly ComputerUseHostRow[];
    }
  | { readonly status: "host_ambiguous" }
  | { readonly status: "host_offline" }
  | { readonly status: "host_unsupported" };

type StartComputerUseHostResult =
  | {
      readonly status: "started";
      readonly hostId: string;
      readonly hostToken: string;
    }
  | { readonly status: "active_host_exists"; readonly hostId: string };

type HeartbeatComputerUseHostResult =
  | { readonly status: "ok"; readonly hostId: string }
  | { readonly status: "invalid_token" }
  | { readonly status: "active_host_exists"; readonly hostId: string };

type StopComputerUseHostResult =
  | { readonly status: "stopped"; readonly hostId: string }
  | { readonly status: "invalid_token" };

type ClaimNextComputerUseHostCommandResult =
  | { readonly status: "invalid_token" }
  | { readonly status: "idle" }
  | {
      readonly status: "command";
      readonly command: ReturnType<typeof serializeCommand>;
    };

type CompleteComputerUseHostCommandResult =
  | { readonly status: "completed" }
  | { readonly status: "invalid_token" }
  | { readonly status: "not_found" }
  | { readonly status: "not_running" };

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function generateOpaqueToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function normalizeHostName(hostName: string): string {
  return hostName.trim().slice(0, 128);
}

function normalizeVersion(version: string): string {
  return version.trim().slice(0, 64);
}

function normalizeOsVersion(version: string): string {
  return version.trim().slice(0, 128);
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

function hostIsOnline(host: ComputerUseHostRow, now: Date): boolean {
  return (
    host.status === "online" &&
    host.revokedAt === null &&
    now.getTime() - host.lastSeenAt.getTime() <=
      COMPUTER_USE_HOST_CLOSED_AFTER_MS
  );
}

function hostSupportsCommand(
  host: ComputerUseHostRow,
  kind: ComputerUseCommandKind,
): boolean {
  return (
    host.supportedCapabilities.length === 0 ||
    host.supportedCapabilities.includes(kind)
  );
}

function isComputerUseWriteCommandKind(
  kind: string,
): kind is ComputerUseWriteCommandKind {
  return COMPUTER_USE_WRITE_COMMANDS.includes(
    kind as ComputerUseWriteCommandKind,
  );
}

function commandPayload(
  params: ComputerUseCommandPayload,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (params.app) {
    payload.app = params.app.trim();
  }
  if (params.snapshotId) {
    payload.snapshotId = params.snapshotId.trim();
  }
  if (params.elementId) {
    payload.elementId = params.elementId.trim();
  }
  if (params.elementIndex !== undefined) {
    payload.elementIndex = params.elementIndex;
  }
  if (params.x !== undefined) {
    payload.x = params.x;
  }
  if (params.y !== undefined) {
    payload.y = params.y;
  }
  if (params.button) {
    payload.button = params.button;
  }
  if (params.clickCount !== undefined) {
    payload.clickCount = params.clickCount;
  }
  if (params.direction) {
    payload.direction = params.direction;
  }
  if (params.pages !== undefined) {
    payload.pages = params.pages;
  }
  if (params.value !== undefined) {
    payload.value = params.value;
  }
  if (params.text !== undefined) {
    payload.text = params.text;
  }
  if (params.key) {
    payload.key = params.key.trim();
  }
  if (params.action) {
    payload.action = params.action.trim();
  }
  return payload;
}

function redactedResultForAudit(
  result: ComputerUseCommandResult | null | undefined,
): Record<string, unknown> | null {
  if (!result) {
    return null;
  }
  const redacted: Record<string, unknown> = {};
  for (const key of [
    "action",
    "app",
    "button",
    "clickCount",
    "direction",
    "dispatchMode",
    "dispatchTarget",
    "elementId",
    "elementIndex",
    "inputRisk",
    "key",
    "pages",
    "role",
    "summary",
    "x",
    "y",
  ]) {
    const value = result[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      redacted[key] = value;
    }
  }
  if (typeof result.appState === "string") {
    redacted.appStateLength = result.appState.length;
  }
  if (typeof result.screenshot === "string") {
    redacted.screenshot = "[redacted]";
  }
  const action = result.action;
  if (action && typeof action === "object" && !Array.isArray(action)) {
    const redactedAction: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(action)) {
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        redactedAction[key] = value;
      }
    }
    if (Object.keys(redactedAction).length > 0) {
      redacted.action = redactedAction;
    }
  }
  if (Object.keys(redacted).length > 0) {
    return redacted;
  }
  return result;
}

function errorForAudit(
  error: ComputerUseCommandError | null | undefined,
): Record<string, unknown> | null {
  return error ? { code: error.code, message: error.message } : null;
}

function commandErrorFromRow(
  row: ComputerUseCommandRow,
): ComputerUseCommandError {
  const result = row.result as Record<string, unknown> | null;
  const error = result?.error;
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    "message" in error &&
    typeof error.code === "string" &&
    typeof error.message === "string"
  ) {
    return {
      code: error.code as ComputerUseCommandError["code"],
      message: error.message,
    };
  }
  return {
    code: "unsupported_command",
    message: row.error ?? "Computer-use command failed",
  };
}

function serializeHost(row: ComputerUseHostRow, now: Date) {
  return {
    id: row.id,
    displayName: row.displayName,
    appVersion: row.appVersion,
    osVersion: row.osVersion,
    supportedCapabilities: row.supportedCapabilities,
    permissions: row.permissions,
    status: hostIsOnline(row, now) ? ("online" as const) : ("offline" as const),
    lastSeenAt: row.lastSeenAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

function serializeCommand(row: ComputerUseCommandRow, hostName: string | null) {
  const result = row.status === "succeeded" ? row.result : null;
  return {
    id: row.id,
    kind: row.kind as ComputerUseCommandKind,
    status: row.status as ComputerUseCommandStatus,
    hostId: row.hostId,
    hostName,
    payload: row.payload,
    ...(result ? { result: result as ComputerUseCommandResult } : {}),
    ...(row.status === "failed" ? { error: commandErrorFromRow(row) } : {}),
    timeoutMs: row.timeoutMs,
    createdAt: row.createdAt.toISOString(),
    claimedAt: row.claimedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

async function insertComputerUseCommandAuditEvent(
  tx: ComputerUseTx,
  params: {
    readonly command: ComputerUseCommandRow;
    readonly event: "created" | "approved" | "denied" | "completed";
    readonly approvalOutcome?: "approved" | "denied";
    readonly result?: ComputerUseCommandResult | null;
    readonly error?: ComputerUseCommandError | null;
    readonly createdAt: Date;
  },
): Promise<void> {
  if (!isComputerUseWriteCommandKind(params.command.kind)) {
    return;
  }

  await tx.insert(computerUseCommandAuditEvents).values({
    commandId: params.command.id,
    orgId: params.command.orgId,
    userId: params.command.userId,
    runId: params.command.runId,
    hostId: params.command.hostId,
    kind: params.command.kind,
    app:
      typeof params.command.payload.app === "string"
        ? params.command.payload.app
        : null,
    event: params.event,
    approvalOutcome: params.approvalOutcome ?? null,
    redactedResult: redactedResultForAudit(params.result),
    error: errorForAudit(params.error),
    createdAt: params.createdAt,
  });
}

function resolveComputerUseCommandTargets(params: {
  readonly onlineHosts: readonly ComputerUseHostRow[];
  readonly kind: ComputerUseCommandKind;
}): ResolveComputerUseCommandTargetsResult {
  if (params.onlineHosts.length === 0) {
    return { status: "host_offline" };
  }

  const supported = params.onlineHosts.filter((host) => {
    return hostSupportsCommand(host, params.kind);
  });
  if (supported.length === 0) {
    return { status: "host_unsupported" };
  }
  if (supported.length > 1) {
    return { status: "host_ambiguous" };
  }

  const [host] = supported;
  if (!host) {
    throw new Error("Expected a supported computer-use host");
  }
  return {
    status: "resolved",
    targetHostId: host.id,
    notifyHosts: [host],
  };
}

async function hostFromToken(
  tx: ComputerUseTx,
  hostToken: string,
  signal: AbortSignal,
): Promise<ComputerUseHostRow | null> {
  const [host] = await tx
    .select()
    .from(computerUseHosts)
    .where(
      and(
        eq(computerUseHosts.tokenHash, hashSecret(hostToken)),
        isNull(computerUseHosts.revokedAt),
      ),
    )
    .for("update")
    .limit(1);
  signal.throwIfAborted();
  return host ?? null;
}

async function hostIdentityFromToken(
  tx: ComputerUseTx,
  hostToken: string,
  signal: AbortSignal,
): Promise<{
  readonly orgId: string;
  readonly userId: string;
} | null> {
  const [host] = await tx
    .select({
      orgId: computerUseHosts.orgId,
      userId: computerUseHosts.userId,
    })
    .from(computerUseHosts)
    .where(
      and(
        eq(computerUseHosts.tokenHash, hashSecret(hostToken)),
        isNull(computerUseHosts.revokedAt),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  return host ?? null;
}

export const startComputerUseHost$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly hostName: string;
      readonly appVersion: string;
      readonly osVersion: string;
      readonly supportedCapabilities: readonly string[];
      readonly permissions: {
        readonly accessibility: boolean;
        readonly screenRecording: boolean;
      };
    },
    signal: AbortSignal,
  ): Promise<StartComputerUseHostResult> => {
    const db = set(writeDb$);
    const hostToken = generateOpaqueToken("vm0_computer_use_host");
    const now = nowDate();
    const result = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('computer_use_host:' || ${params.orgId} || ':' || ${params.userId}))`,
      );

      const existingHosts = await tx
        .select()
        .from(computerUseHosts)
        .where(
          and(
            eq(computerUseHosts.orgId, params.orgId),
            eq(computerUseHosts.userId, params.userId),
            isNull(computerUseHosts.revokedAt),
          ),
        )
        .for("update");
      signal.throwIfAborted();

      const activeHost = existingHosts.find((host) => {
        return hostIsOnline(host, now);
      });
      if (activeHost) {
        return {
          status: "active_host_exists" as const,
          hostId: activeHost.id,
        };
      }

      const [host] = await tx
        .insert(computerUseHosts)
        .values({
          orgId: params.orgId,
          userId: params.userId,
          displayName: normalizeHostName(params.hostName),
          tokenHash: hashSecret(hostToken),
          appVersion: normalizeVersion(params.appVersion),
          osVersion: normalizeOsVersion(params.osVersion),
          supportedCapabilities: normalizeCapabilities(
            params.supportedCapabilities,
          ),
          permissions: params.permissions,
          status: "online",
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: computerUseHosts.id });
      signal.throwIfAborted();

      if (!host) {
        throw new Error("Failed to start computer-use host");
      }

      return { status: "started" as const, hostId: host.id, hostToken };
    });
    signal.throwIfAborted();
    return result;
  },
);

export const heartbeatComputerUseHost$ = command(
  async (
    { set },
    params: {
      readonly hostToken: string;
      readonly hostName: string;
      readonly appVersion: string;
      readonly osVersion: string;
      readonly supportedCapabilities: readonly string[];
      readonly permissions: {
        readonly accessibility: boolean;
        readonly screenRecording: boolean;
      };
    },
    signal: AbortSignal,
  ): Promise<HeartbeatComputerUseHostResult> => {
    const db = set(writeDb$);
    const now = nowDate();
    const result = await db.transaction(async (tx) => {
      const hostIdentity = await hostIdentityFromToken(
        tx,
        params.hostToken,
        signal,
      );
      if (!hostIdentity) {
        return { status: "invalid_token" as const };
      }
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('computer_use_host:' || ${hostIdentity.orgId} || ':' || ${hostIdentity.userId}))`,
      );
      signal.throwIfAborted();

      const lockedHost = await hostFromToken(tx, params.hostToken, signal);
      if (!lockedHost) {
        return { status: "invalid_token" as const };
      }

      const existingHosts = await tx
        .select()
        .from(computerUseHosts)
        .where(
          and(
            eq(computerUseHosts.orgId, lockedHost.orgId),
            eq(computerUseHosts.userId, lockedHost.userId),
            isNull(computerUseHosts.revokedAt),
          ),
        )
        .for("update");
      signal.throwIfAborted();

      const activeHost = existingHosts.find((candidate) => {
        return candidate.id !== lockedHost.id && hostIsOnline(candidate, now);
      });
      if (activeHost) {
        await tx
          .update(computerUseHosts)
          .set({ status: "offline", revokedAt: now, updatedAt: now })
          .where(eq(computerUseHosts.id, lockedHost.id));
        signal.throwIfAborted();
        return {
          status: "active_host_exists" as const,
          hostId: activeHost.id,
        };
      }

      await tx
        .update(computerUseHosts)
        .set({
          displayName: normalizeHostName(params.hostName),
          appVersion: normalizeVersion(params.appVersion),
          osVersion: normalizeOsVersion(params.osVersion),
          supportedCapabilities: normalizeCapabilities(
            params.supportedCapabilities,
          ),
          permissions: params.permissions,
          status: "online",
          lastSeenAt: now,
          updatedAt: now,
        })
        .where(eq(computerUseHosts.id, lockedHost.id));
      signal.throwIfAborted();
      return { status: "ok" as const, hostId: lockedHost.id };
    });
    signal.throwIfAborted();
    return result;
  },
);

export const stopComputerUseHost$ = command(
  async (
    { set },
    params: {
      readonly hostToken: string;
    },
    signal: AbortSignal,
  ): Promise<StopComputerUseHostResult> => {
    const db = set(writeDb$);
    const now = nowDate();
    const result = await db.transaction(async (tx) => {
      const host = await hostFromToken(tx, params.hostToken, signal);
      if (!host) {
        return { status: "invalid_token" as const };
      }

      await tx
        .update(computerUseHosts)
        .set({ status: "offline", revokedAt: now, updatedAt: now })
        .where(eq(computerUseHosts.id, host.id));
      signal.throwIfAborted();
      return { status: "stopped" as const, hostId: host.id };
    });
    signal.throwIfAborted();
    return result;
  },
);

export const listComputerUseHosts$ = command(
  async (
    { set },
    params: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const now = nowDate();
    const hosts = await db
      .select()
      .from(computerUseHosts)
      .where(
        and(
          eq(computerUseHosts.orgId, params.orgId),
          eq(computerUseHosts.userId, params.userId),
          isNull(computerUseHosts.revokedAt),
        ),
      )
      .orderBy(desc(computerUseHosts.lastSeenAt));
    signal.throwIfAborted();
    return {
      hosts: hosts.map((host) => {
        return serializeHost(host, now);
      }),
    };
  },
);

export const deleteComputerUseHost$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly hostId: string;
    },
    signal: AbortSignal,
  ): Promise<
    { readonly status: "deleted" } | { readonly status: "not_found" }
  > => {
    const db = set(writeDb$);
    const now = nowDate();
    const [host] = await db
      .update(computerUseHosts)
      .set({ status: "offline", revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(computerUseHosts.id, params.hostId),
          eq(computerUseHosts.orgId, params.orgId),
          eq(computerUseHosts.userId, params.userId),
          isNull(computerUseHosts.revokedAt),
        ),
      )
      .returning({ id: computerUseHosts.id });
    signal.throwIfAborted();
    return host ? { status: "deleted" } : { status: "not_found" };
  },
);

export const createComputerUseCommand$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly runId?: string;
      readonly kind: ComputerUseCommandKind;
      readonly payload: ComputerUseCommandPayload;
      readonly timeoutMs?: number;
      readonly requiresApproval: boolean;
    },
    signal: AbortSignal,
  ): Promise<CreateComputerUseCommandResult> => {
    if (!COMPUTER_USE_COMMANDS.includes(params.kind)) {
      return { status: "host_unsupported" };
    }

    const db = set(writeDb$);
    const now = nowDate();
    const hosts = await db
      .select()
      .from(computerUseHosts)
      .where(
        and(
          eq(computerUseHosts.orgId, params.orgId),
          eq(computerUseHosts.userId, params.userId),
          isNull(computerUseHosts.revokedAt),
        ),
      )
      .orderBy(desc(computerUseHosts.lastSeenAt));
    signal.throwIfAborted();

    if (hosts.length === 0) {
      return { status: "no_host" };
    }

    const onlineHosts = hosts.filter((host) => {
      return hostIsOnline(host, now);
    });
    const target = resolveComputerUseCommandTargets({
      onlineHosts,
      kind: params.kind,
    });
    if (target.status !== "resolved") {
      return target;
    }

    const commandStatus = params.requiresApproval
      ? ("pending_approval" as const)
      : ("queued" as const);
    const payload = commandPayload(params.payload);
    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(computerUseCommands)
        .values({
          orgId: params.orgId,
          userId: params.userId,
          runId: params.runId ?? null,
          hostId: target.targetHostId,
          kind: params.kind,
          status: commandStatus,
          payload,
          timeoutMs: params.timeoutMs,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      signal.throwIfAborted();

      if (!created) {
        throw new Error("Failed to create computer-use command");
      }

      if (params.requiresApproval) {
        await insertComputerUseCommandAuditEvent(tx, {
          command: created,
          event: "created",
          createdAt: now,
        });
        signal.throwIfAborted();
      }

      return created;
    });
    signal.throwIfAborted();

    return {
      status: "created",
      commandId: row.id,
      commandStatus,
    };
  },
);

export const getComputerUseCommand$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly commandId: string;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const [row] = await db
      .select({
        command: computerUseCommands,
        hostName: computerUseHosts.displayName,
      })
      .from(computerUseCommands)
      .leftJoin(
        computerUseHosts,
        eq(computerUseCommands.hostId, computerUseHosts.id),
      )
      .where(
        and(
          eq(computerUseCommands.orgId, params.orgId),
          eq(computerUseCommands.userId, params.userId),
          eq(computerUseCommands.id, params.commandId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return row ? serializeCommand(row.command, row.hostName) : null;
  },
);

async function denyPendingComputerUseWriteCommand(
  tx: ComputerUseTx,
  commandRow: ComputerUseCommandRow,
  params: { readonly message?: string },
  now: Date,
  signal: AbortSignal,
) {
  const error: ComputerUseCommandError = {
    code: "permission_denied",
    message: params.message ?? "Computer-use command was denied",
  };
  const [updated] = await tx
    .update(computerUseCommands)
    .set({
      status: "failed",
      result: { error },
      error: error.code,
      completedAt: now,
      updatedAt: now,
    })
    .where(eq(computerUseCommands.id, commandRow.id))
    .returning();
  signal.throwIfAborted();

  if (!updated) {
    throw new Error("Failed to deny computer-use command");
  }

  await insertComputerUseCommandAuditEvent(tx, {
    command: updated,
    event: "denied",
    approvalOutcome: "denied",
    error,
    createdAt: now,
  });
  signal.throwIfAborted();

  return { status: "denied" as const, commandId: commandRow.id };
}

async function approvePendingComputerUseWriteCommand(
  tx: ComputerUseTx,
  commandRow: ComputerUseCommandRow,
  now: Date,
  signal: AbortSignal,
) {
  const [updated] = await tx
    .update(computerUseCommands)
    .set({ status: "queued", updatedAt: now })
    .where(eq(computerUseCommands.id, commandRow.id))
    .returning();
  signal.throwIfAborted();

  if (!updated) {
    throw new Error("Failed to approve computer-use command");
  }

  await insertComputerUseCommandAuditEvent(tx, {
    command: updated,
    event: "approved",
    approvalOutcome: "approved",
    createdAt: now,
  });
  signal.throwIfAborted();

  return { status: "approved" as const, commandId: commandRow.id };
}

export const approveComputerUseWriteCommand$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly commandId: string;
      readonly decision: "approve" | "deny";
      readonly message?: string;
    },
    signal: AbortSignal,
  ): Promise<ApproveComputerUseWriteCommandResult> => {
    const db = set(writeDb$);
    const now = nowDate();
    const result = await db.transaction(async (tx) => {
      const [commandRow] = await tx
        .select()
        .from(computerUseCommands)
        .where(
          and(
            eq(computerUseCommands.id, params.commandId),
            eq(computerUseCommands.orgId, params.orgId),
            eq(computerUseCommands.userId, params.userId),
          ),
        )
        .for("update")
        .limit(1);
      signal.throwIfAborted();

      if (!commandRow || !isComputerUseWriteCommandKind(commandRow.kind)) {
        return { status: "not_found" as const };
      }
      if (commandRow.status !== "pending_approval") {
        return { status: "not_pending" as const };
      }
      if (params.decision === "deny") {
        return await denyPendingComputerUseWriteCommand(
          tx,
          commandRow,
          { message: params.message },
          now,
          signal,
        );
      }
      return await approvePendingComputerUseWriteCommand(
        tx,
        commandRow,
        now,
        signal,
      );
    });
    signal.throwIfAborted();
    return result;
  },
);

export const claimNextComputerUseHostCommand$ = command(
  async (
    { set },
    params: {
      readonly hostToken: string;
      readonly supportedCapabilities: readonly string[];
    },
    signal: AbortSignal,
  ): Promise<ClaimNextComputerUseHostCommandResult> => {
    const db = set(writeDb$);
    const now = nowDate();
    const capabilities = normalizeCapabilities(params.supportedCapabilities);
    const result = await db.transaction(async (tx) => {
      const host = await hostFromToken(tx, params.hostToken, signal);
      if (!host) {
        return { status: "invalid_token" as const };
      }

      await tx
        .update(computerUseHosts)
        .set({
          supportedCapabilities: capabilities,
          status: "online",
          lastSeenAt: now,
          updatedAt: now,
        })
        .where(eq(computerUseHosts.id, host.id));
      signal.throwIfAborted();

      const effectiveCapabilities =
        capabilities.length > 0 ? capabilities : host.supportedCapabilities;
      const commandFilter =
        effectiveCapabilities.length > 0
          ? inArray(computerUseCommands.kind, effectiveCapabilities)
          : inArray(computerUseCommands.kind, COMPUTER_USE_COMMANDS);
      const [row] = await tx
        .select()
        .from(computerUseCommands)
        .where(
          and(
            eq(computerUseCommands.orgId, host.orgId),
            eq(computerUseCommands.userId, host.userId),
            eq(computerUseCommands.status, "queued"),
            or(
              eq(computerUseCommands.hostId, host.id),
              isNull(computerUseCommands.hostId),
            ),
            commandFilter,
          ),
        )
        .orderBy(asc(computerUseCommands.createdAt))
        .for("update", { skipLocked: true })
        .limit(1);
      signal.throwIfAborted();

      if (!row) {
        return { status: "idle" as const };
      }

      const [updated] = await tx
        .update(computerUseCommands)
        .set({
          hostId: host.id,
          status: "running",
          claimedAt: now,
          updatedAt: now,
        })
        .where(eq(computerUseCommands.id, row.id))
        .returning();
      signal.throwIfAborted();

      if (!updated) {
        throw new Error("Failed to claim computer-use command");
      }

      return {
        status: "command" as const,
        command: serializeCommand(updated, host.displayName),
      };
    });
    signal.throwIfAborted();
    return result;
  },
);

export const completeComputerUseHostCommand$ = command(
  async (
    { set },
    params:
      | {
          readonly hostToken: string;
          readonly commandId: string;
          readonly status: "succeeded";
          readonly result: ComputerUseCommandResult;
        }
      | {
          readonly hostToken: string;
          readonly commandId: string;
          readonly status: "failed";
          readonly error: ComputerUseCommandError;
        },
    signal: AbortSignal,
  ): Promise<CompleteComputerUseHostCommandResult> => {
    const db = set(writeDb$);
    const now = nowDate();
    const result = await db.transaction(async (tx) => {
      const host = await hostFromToken(tx, params.hostToken, signal);
      if (!host) {
        return { status: "invalid_token" as const };
      }

      const [commandRow] = await tx
        .select()
        .from(computerUseCommands)
        .where(
          and(
            eq(computerUseCommands.id, params.commandId),
            eq(computerUseCommands.hostId, host.id),
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

      const commandResult =
        params.status === "succeeded" ? params.result : { error: params.error };
      const [updated] = await tx
        .update(computerUseCommands)
        .set({
          status: params.status,
          result: commandResult,
          error: params.status === "failed" ? params.error.code : null,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(computerUseCommands.id, params.commandId))
        .returning();
      signal.throwIfAborted();

      if (!updated) {
        throw new Error("Failed to complete computer-use command");
      }

      await insertComputerUseCommandAuditEvent(tx, {
        command: updated,
        event: "completed",
        result: params.status === "succeeded" ? params.result : null,
        error: params.status === "failed" ? params.error : null,
        createdAt: now,
      });
      signal.throwIfAborted();

      await tx
        .update(computerUseHosts)
        .set({ status: "online", lastSeenAt: now, updatedAt: now })
        .where(eq(computerUseHosts.id, host.id));
      signal.throwIfAborted();

      return { status: "completed" as const };
    });
    signal.throwIfAborted();
    return result;
  },
);

export const listComputerUseAuditEvents$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly limit: number;
      readonly commandId?: string;
      readonly hostId?: string;
      readonly runId?: string;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const filters = [
      eq(computerUseCommandAuditEvents.orgId, params.orgId),
      eq(computerUseCommandAuditEvents.userId, params.userId),
    ];
    if (params.commandId) {
      filters.push(
        eq(computerUseCommandAuditEvents.commandId, params.commandId),
      );
    }
    if (params.hostId) {
      filters.push(eq(computerUseCommandAuditEvents.hostId, params.hostId));
    }
    if (params.runId) {
      filters.push(eq(computerUseCommandAuditEvents.runId, params.runId));
    }

    const rows = await db
      .select()
      .from(computerUseCommandAuditEvents)
      .where(and(...filters))
      .orderBy(desc(computerUseCommandAuditEvents.createdAt))
      .limit(params.limit);
    signal.throwIfAborted();

    L.debug("Listed computer-use audit events", {
      orgId: params.orgId,
      count: rows.length,
    });

    return {
      auditEvents: rows.map((row) => {
        return {
          id: row.id,
          commandId: row.commandId,
          runId: row.runId,
          hostId: row.hostId,
          kind: row.kind as ComputerUseWriteCommandKind,
          app: row.app,
          event: row.event as "created" | "approved" | "denied" | "completed",
          approvalOutcome: row.approvalOutcome as "approved" | "denied" | null,
          redactedResult: row.redactedResult,
          error: row.error,
          createdAt: row.createdAt.toISOString(),
        };
      }),
    };
  },
);
