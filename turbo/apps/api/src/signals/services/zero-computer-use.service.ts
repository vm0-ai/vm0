import { createHash, randomBytes } from "node:crypto";

import { command, computed, type Computed } from "ccstate";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  isExpiredPluginContentPointer,
  isExpiredScreenshotPointer,
  isStoredPluginContentPointer,
  isStoredScreenshotPointer,
  type ClientPluginContentPointer,
  type ClientScreenshotPointer,
  type ComputerUseCommandError,
  type ComputerUseCommandKind,
  type ComputerUseCommandResult,
  type ComputerUseCommandStatus,
  type ComputerUseHost,
  type ComputerUsePluginCommandKind,
  type ComputerUseReadCommandKind,
  type ComputerUseWriteCommandKind,
  type StoredPluginContentPointer,
  type StoredScreenshotPointer,
} from "@vm0/api-contracts/contracts/zero-computer-use";
import {
  COMPUTER_USE_PLUGIN_CALL_KIND,
  COMPUTER_USE_PLUGIN_RESULT_BLOB_MAX_BYTES,
  COMPUTER_USE_PLUGIN_RESULT_INLINE_TEXT_MAX_BYTES,
  computerUseFilesystemToolIsDestructive,
  computerUsePluginCallRequiredCapabilities,
  isComputerUsePluginCallPayload,
} from "@vm0/api-contracts/contracts/zero-computer-use-plugins";
import {
  computerUseCommandAuditEvents,
  computerUseCommands,
  computerUseHosts,
} from "@vm0/db/schema/computer-use-host";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { slackOrgThreadSessions } from "@vm0/db/schema/slack-org-thread-session";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { downloadS3Buffer, putS3Object } from "../external/s3";

const COMPUTER_USE_HOST_CLOSED_AFTER_MS = 90 * 1000;
const COMPUTER_USE_RUNNING_COMMAND_DEFAULT_TIMEOUT_MS = 120 * 1000;
const COMPUTER_USE_HOSTS_CHANGED_TOPIC = "computerUseHostsChanged";
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
const COMPUTER_USE_PLUGIN_COMMANDS = [
  COMPUTER_USE_PLUGIN_CALL_KIND,
] as const satisfies readonly ComputerUsePluginCommandKind[];
const COMPUTER_USE_COMMANDS = [
  ...COMPUTER_USE_READ_COMMANDS,
  ...COMPUTER_USE_WRITE_COMMANDS,
  ...COMPUTER_USE_PLUGIN_COMMANDS,
] as const satisfies readonly ComputerUseCommandKind[];
const COMPUTER_USE_LEGACY_COMMANDS = [
  ...COMPUTER_USE_READ_COMMANDS,
  ...COMPUTER_USE_WRITE_COMMANDS,
] as const satisfies readonly ComputerUseCommandKind[];
const DEFAULT_COMPUTER_USE_AUTOMATION_PERMISSIONS = {
  chrome: {
    status: "unknown",
    updatedAt: null,
    reason: null,
  },
  safari: {
    status: "unknown",
    updatedAt: null,
    reason: null,
  },
} as const;

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
  readonly plugin?: string;
  readonly tool?: string;
  readonly arguments?: Record<string, unknown>;
}

type CreateComputerUseCommandResult =
  | {
      readonly status: "created";
      readonly commandId: string;
      readonly commandStatus: "queued";
    }
  | { readonly status: "no_host" }
  | { readonly status: "host_ambiguous" }
  | { readonly status: "host_offline" }
  | { readonly status: "host_unsupported" };

type ResolveComputerUseCommandTargetsResult =
  | {
      readonly status: "resolved";
      readonly targetHostId: string;
      readonly notifyHosts: readonly ComputerUseHostRow[];
    }
  | { readonly status: "host_ambiguous" }
  | { readonly status: "host_offline" }
  | { readonly status: "host_unsupported" };

type StartComputerUseHostResult = {
  readonly status: "started";
  readonly hostId: string;
  readonly hostToken: string;
};

type HeartbeatComputerUseHostResult =
  | { readonly status: "ok"; readonly hostId: string }
  | { readonly status: "invalid_token" };

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
type CompleteComputerUseHostCommandState =
  | CompleteComputerUseHostCommandResult
  | { readonly status: "running"; readonly host: ComputerUseHostRow };

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function generateOpaqueToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function invalidatedHostTokenHash(): string {
  return hashSecret(generateOpaqueToken("vm0_computer_use_host_stopped"));
}

function normalizeHostName(hostName: string): string {
  return hostName.trim().slice(0, 253);
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

function sameStringArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => {
      return value === right[index];
    })
  );
}

function samePermissions(
  left: ComputerUseHostRow["permissions"],
  right: ComputerUseHostRow["permissions"],
): boolean {
  const normalizedLeft = normalizeHostPermissions(left);
  const normalizedRight = normalizeHostPermissions(right);
  return (
    normalizedLeft.accessibility === normalizedRight.accessibility &&
    normalizedLeft.screenRecording === normalizedRight.screenRecording &&
    JSON.stringify(normalizedLeft.automation) ===
      JSON.stringify(normalizedRight.automation)
  );
}

function normalizeHostPermissions(
  permissions: ComputerUseHostRow["permissions"],
): ComputerUseHost["permissions"] {
  return {
    accessibility: permissions.accessibility,
    screenRecording: permissions.screenRecording,
    automation: {
      chrome: {
        ...DEFAULT_COMPUTER_USE_AUTOMATION_PERMISSIONS.chrome,
        ...permissions.automation?.chrome,
      },
      safari: {
        ...DEFAULT_COMPUTER_USE_AUTOMATION_PERMISSIONS.safari,
        ...permissions.automation?.safari,
      },
    },
  };
}

export function computerUseHostIsOnline(
  host: {
    readonly status: string;
    readonly revokedAt: Date | null;
    readonly lastSeenAt: Date;
  },
  now: Date,
): boolean {
  return (
    host.status === "online" &&
    host.revokedAt === null &&
    now.getTime() - host.lastSeenAt.getTime() <=
      COMPUTER_USE_HOST_CLOSED_AFTER_MS
  );
}

async function publishComputerUseHostsChanged(userId: string): Promise<void> {
  await publishUserSignal([userId], COMPUTER_USE_HOSTS_CHANGED_TOPIC);
}

async function clearComputerUseHostThreadBindings(params: {
  readonly tx: ComputerUseTx;
  readonly userId: string;
  readonly hostId: string;
}): Promise<void> {
  const now = nowDate();
  await params.tx
    .update(chatThreads)
    .set({ computerUseHostId: null, updatedAt: now })
    .where(
      and(
        eq(chatThreads.userId, params.userId),
        eq(chatThreads.computerUseHostId, params.hostId),
      ),
    );
  await params.tx
    .update(slackOrgThreadSessions)
    .set({ computerUseHostId: null, updatedAt: now })
    .where(eq(slackOrgThreadSessions.computerUseHostId, params.hostId));
}

function isComputerUseWriteCommandKind(
  kind: string,
): kind is ComputerUseWriteCommandKind {
  return COMPUTER_USE_WRITE_COMMANDS.includes(
    kind as ComputerUseWriteCommandKind,
  );
}

function isComputerUsePluginCommandKind(
  kind: string,
): kind is ComputerUsePluginCommandKind {
  return COMPUTER_USE_PLUGIN_COMMANDS.includes(
    kind as ComputerUsePluginCommandKind,
  );
}

function commandRequiredCapabilities(params: {
  readonly kind: ComputerUseCommandKind;
  readonly payload: Record<string, unknown>;
}): readonly string[] {
  if (params.kind === COMPUTER_USE_PLUGIN_CALL_KIND) {
    if (!isComputerUsePluginCallPayload(params.payload)) {
      return [COMPUTER_USE_PLUGIN_CALL_KIND];
    }
    return computerUsePluginCallRequiredCapabilities({
      plugin: params.payload.plugin,
      tool: params.payload.tool,
    });
  }
  return [params.kind];
}

function hostSupportsCommand(params: {
  readonly host: Pick<ComputerUseHostRow, "supportedCapabilities">;
  readonly kind: ComputerUseCommandKind;
  readonly payload: Record<string, unknown>;
}): boolean {
  if (params.host.supportedCapabilities.length === 0) {
    return COMPUTER_USE_LEGACY_COMMANDS.includes(params.kind);
  }
  const required = commandRequiredCapabilities({
    kind: params.kind,
    payload: params.payload,
  });
  return required.every((capability) => {
    return params.host.supportedCapabilities.includes(capability);
  });
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
  if (params.plugin) {
    payload.plugin = params.plugin.trim();
  }
  if (params.tool) {
    payload.tool = params.tool.trim();
  }
  if (params.arguments) {
    payload.arguments = params.arguments;
  }
  return payload;
}

const SCREENSHOT_DATA_URL_PATTERN = /^data:([^;,]+);base64,(.*)$/s;

function parseScreenshotDataUrl(
  value: string,
): { readonly mimeType: string; readonly buffer: Buffer } | null {
  const match = SCREENSHOT_DATA_URL_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const mimeType = match[1] ?? "";
  if (!mimeType.startsWith("image/")) {
    return null;
  }
  return { mimeType, buffer: Buffer.from(match[2] ?? "", "base64") };
}

function extensionForScreenshotMime(mimeType: string): string {
  if (mimeType === "image/png") {
    return "png";
  }
  if (mimeType === "image/jpeg") {
    return "jpg";
  }
  if (mimeType === "image/webp") {
    return "webp";
  }
  return "bin";
}

function extensionForPluginMime(mimeType: string): string {
  if (mimeType === "text/plain") {
    return "txt";
  }
  if (mimeType === "application/json") {
    return "json";
  }
  const suffix = mimeType.includes("/") ? mimeType.split("/").at(-1) : null;
  return suffix?.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 16) || "bin";
}

function numberField(result: ComputerUseCommandResult, key: string): number {
  const value = result[key];
  return typeof value === "number" ? value : 0;
}

/**
 * Upload an inline base64 screenshot to private object storage and return a
 * copy of the result with `screenshot` replaced by an object-storage pointer.
 * Runs outside the completion transaction so the command row lock is never held
 * across S3 network I/O. Returns the result unchanged when there is no inline
 * screenshot (older clients, non-screenshot commands, or already a pointer).
 */
function offloadScreenshotForResult(
  db: Db,
  params: {
    readonly hostToken: string;
    readonly commandId: string;
    readonly result: ComputerUseCommandResult;
  },
  signal: AbortSignal,
): Computed<Promise<ComputerUseCommandResult>> {
  return computed(async (get): Promise<ComputerUseCommandResult> => {
    const screenshot = params.result.screenshot;
    if (typeof screenshot !== "string") {
      return params.result;
    }
    const parsed = parseScreenshotDataUrl(screenshot);
    if (!parsed) {
      return params.result;
    }

    const [identity] = await db
      .select({
        orgId: computerUseHosts.orgId,
        userId: computerUseHosts.userId,
      })
      .from(computerUseHosts)
      .where(
        and(
          eq(computerUseHosts.tokenHash, hashSecret(params.hostToken)),
          isNull(computerUseHosts.revokedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!identity) {
      return params.result;
    }

    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const key = `computer-use/${identity.orgId}/${identity.userId}/${params.commandId}/screenshot.${extensionForScreenshotMime(parsed.mimeType)}`;
    await get(putS3Object(bucket, key, parsed.buffer, parsed.mimeType));
    signal.throwIfAborted();

    const pointer: StoredScreenshotPointer = {
      type: "s3",
      bucket,
      key,
      mimeType: parsed.mimeType,
      sizeBytes: parsed.buffer.length,
      width: numberField(params.result, "screenshotWidth"),
      height: numberField(params.result, "screenshotHeight"),
    };
    return { ...params.result, screenshot: pointer };
  });
}

interface InlinePluginContent {
  readonly dataBase64: string;
  readonly mimeType: string;
  readonly fileName: string;
}

function inlinePluginContent(value: unknown): InlinePluginContent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const content = value as {
    readonly dataBase64?: unknown;
    readonly mimeType?: unknown;
    readonly fileName?: unknown;
  };
  if (
    typeof content.dataBase64 !== "string" ||
    typeof content.mimeType !== "string" ||
    typeof content.fileName !== "string"
  ) {
    return null;
  }
  return {
    dataBase64: content.dataBase64,
    mimeType: content.mimeType,
    fileName: content.fileName,
  };
}

function offloadPluginContentForResult(
  db: Db,
  params: {
    readonly hostToken: string;
    readonly commandId: string;
    readonly result: ComputerUseCommandResult;
  },
  signal: AbortSignal,
): Computed<Promise<ComputerUseCommandResult>> {
  return computed(async (get): Promise<ComputerUseCommandResult> => {
    const pluginContent = inlinePluginContent(params.result.pluginContent);
    const inlineContent = params.result.content;
    if (
      typeof inlineContent === "string" &&
      Buffer.byteLength(inlineContent, "utf8") >
        COMPUTER_USE_PLUGIN_RESULT_INLINE_TEXT_MAX_BYTES
    ) {
      const error: ComputerUseCommandError = {
        code: "result_too_large",
        message: `Computer-use plugin inline result exceeds ${COMPUTER_USE_PLUGIN_RESULT_INLINE_TEXT_MAX_BYTES} bytes`,
      };
      return { error };
    }
    if (!pluginContent) {
      return params.result;
    }

    const buffer = Buffer.from(pluginContent.dataBase64, "base64");
    if (buffer.length > COMPUTER_USE_PLUGIN_RESULT_BLOB_MAX_BYTES) {
      const error: ComputerUseCommandError = {
        code: "result_too_large",
        message: `Computer-use plugin result exceeds ${COMPUTER_USE_PLUGIN_RESULT_BLOB_MAX_BYTES} bytes`,
      };
      return { error };
    }

    const [identity] = await db
      .select({
        orgId: computerUseHosts.orgId,
        userId: computerUseHosts.userId,
      })
      .from(computerUseHosts)
      .where(
        and(
          eq(computerUseHosts.tokenHash, hashSecret(params.hostToken)),
          isNull(computerUseHosts.revokedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!identity) {
      return params.result;
    }

    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const key = `computer-use/${identity.orgId}/${identity.userId}/${params.commandId}/plugin-content.${extensionForPluginMime(pluginContent.mimeType)}`;
    await get(putS3Object(bucket, key, buffer, pluginContent.mimeType));
    signal.throwIfAborted();

    const pointer: StoredPluginContentPointer = {
      type: "s3",
      bucket,
      key,
      mimeType: pluginContent.mimeType,
      sizeBytes: buffer.length,
      fileName: pluginContent.fileName,
    };
    return { ...params.result, pluginContent: pointer };
  });
}

/**
 * Map a stored result's screenshot pointer to its client-facing form, dropping
 * the internal `bucket`/`key` so storage layout never leaves the API. Inline
 * (legacy) string screenshots and pointer-free results pass through unchanged.
 */
function toClientResult(
  result: Record<string, unknown>,
): Record<string, unknown> {
  const screenshot = result.screenshot;
  if (isStoredScreenshotPointer(screenshot)) {
    const clientPointer: ClientScreenshotPointer = {
      type: "s3",
      mimeType: screenshot.mimeType,
      sizeBytes: screenshot.sizeBytes,
      width: screenshot.width,
      height: screenshot.height,
    };
    return { ...result, screenshot: clientPointer };
  }
  if (isExpiredScreenshotPointer(screenshot)) {
    const clientPointer: ClientScreenshotPointer = { type: "expired" };
    return { ...result, screenshot: clientPointer };
  }
  const pluginContent = result.pluginContent;
  if (isStoredPluginContentPointer(pluginContent)) {
    const clientPointer: ClientPluginContentPointer = {
      type: "s3",
      mimeType: pluginContent.mimeType,
      sizeBytes: pluginContent.sizeBytes,
      fileName: pluginContent.fileName,
    };
    return { ...result, pluginContent: clientPointer };
  }
  if (isExpiredPluginContentPointer(pluginContent)) {
    const clientPointer: ClientPluginContentPointer = { type: "expired" };
    return { ...result, pluginContent: clientPointer };
  }
  return result;
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
  if (
    typeof result.screenshot === "string" ||
    (typeof result.screenshot === "object" && result.screenshot !== null)
  ) {
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

function stringArrayMetadata(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter((entry): entry is string => {
    return typeof entry === "string";
  });
  return strings.length > 0 ? strings : undefined;
}

function pluginCommandAuditMetadata(params: {
  readonly command: ComputerUseCommandRow;
  readonly result?: ComputerUseCommandResult | null;
  readonly error?: ComputerUseCommandError | null;
}): Record<string, unknown> | null {
  if (!isComputerUsePluginCallPayload(params.command.payload)) {
    return null;
  }

  const args = params.command.payload.arguments;
  const metadata: Record<string, unknown> = {
    plugin: params.command.payload.plugin,
    tool: params.command.payload.tool,
    status: params.error ? "failed" : "succeeded",
    destructive: computerUseFilesystemToolIsDestructive(
      params.command.payload.tool,
    ),
  };

  const path = args.path;
  if (typeof path === "string") {
    metadata.path = path;
  }
  const paths = stringArrayMetadata(args.paths);
  if (paths) {
    metadata.paths = paths;
  }
  const source = args.source;
  if (typeof source === "string") {
    metadata.source = source;
  }
  const destination = args.destination;
  if (typeof destination === "string") {
    metadata.destination = destination;
  }

  const result = params.result;
  if (result) {
    if (typeof result.sizeBytes === "number") {
      metadata.sizeBytes = result.sizeBytes;
    }
    if (typeof result.truncated === "boolean") {
      metadata.truncated = result.truncated;
    }
    const pluginContent = result.pluginContent;
    if (isStoredPluginContentPointer(pluginContent)) {
      metadata.offloaded = true;
      metadata.sizeBytes = pluginContent.sizeBytes;
      metadata.fileName = pluginContent.fileName;
      metadata.mimeType = pluginContent.mimeType;
    } else if (isExpiredPluginContentPointer(pluginContent)) {
      metadata.offloaded = true;
      metadata.expired = true;
    }
  }

  return metadata;
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

function commandErrorFromResult(
  result: ComputerUseCommandResult | null | undefined,
): ComputerUseCommandError | null {
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
  return null;
}

function runningCommandHasTimedOut(
  row: ComputerUseCommandRow,
  now: Date,
): boolean {
  if (!row.claimedAt) {
    return false;
  }
  const timeoutMs =
    row.timeoutMs ?? COMPUTER_USE_RUNNING_COMMAND_DEFAULT_TIMEOUT_MS;
  return now.getTime() - row.claimedAt.getTime() > timeoutMs;
}

function timeoutErrorForCommand(
  row: ComputerUseCommandRow,
): ComputerUseCommandError {
  const timeoutMs =
    row.timeoutMs ?? COMPUTER_USE_RUNNING_COMMAND_DEFAULT_TIMEOUT_MS;
  return {
    code: "timeout",
    message: `Computer-use command timed out after ${timeoutMs}ms`,
  };
}

function serializeHost(row: ComputerUseHostRow, now: Date) {
  return {
    id: row.id,
    hostName: row.displayName,
    displayName: row.displayName,
    appVersion: row.appVersion,
    osVersion: row.osVersion,
    supportedCapabilities: row.supportedCapabilities,
    permissions: normalizeHostPermissions(row.permissions),
    status: computerUseHostIsOnline(row, now)
      ? ("online" as const)
      : ("offline" as const),
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
    ...(result
      ? { result: toClientResult(result) as ComputerUseCommandResult }
      : {}),
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
    readonly event: "completed";
    readonly result?: ComputerUseCommandResult | null;
    readonly error?: ComputerUseCommandError | null;
    readonly createdAt: Date;
  },
): Promise<void> {
  const auditPluginCommand = isComputerUsePluginCommandKind(
    params.command.kind,
  );
  if (
    !isComputerUseWriteCommandKind(params.command.kind) &&
    !auditPluginCommand
  ) {
    return;
  }
  const redactedResult = auditPluginCommand
    ? pluginCommandAuditMetadata({
        command: params.command,
        result: params.result,
        error: params.error,
      })
    : redactedResultForAudit(params.result);

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
    redactedResult,
    error: errorForAudit(params.error),
    createdAt: params.createdAt,
  });
}

async function failStaleRunningComputerUseCommands(
  tx: ComputerUseTx,
  params: {
    readonly orgId: string;
    readonly userId: string;
    readonly hostId?: string;
    readonly now: Date;
  },
  signal: AbortSignal,
): Promise<void> {
  const filters: SQL[] = [
    eq(computerUseCommands.orgId, params.orgId),
    eq(computerUseCommands.userId, params.userId),
    eq(computerUseCommands.status, "running"),
  ];
  if (params.hostId) {
    filters.push(eq(computerUseCommands.hostId, params.hostId));
  }

  const runningCommands = await tx
    .select()
    .from(computerUseCommands)
    .where(and(...filters))
    .for("update", { skipLocked: true });
  signal.throwIfAborted();

  for (const commandRow of runningCommands) {
    if (!runningCommandHasTimedOut(commandRow, params.now)) {
      continue;
    }

    const error = timeoutErrorForCommand(commandRow);
    const [updated] = await tx
      .update(computerUseCommands)
      .set({
        status: "failed",
        result: { error },
        error: error.code,
        completedAt: params.now,
        updatedAt: params.now,
      })
      .where(eq(computerUseCommands.id, commandRow.id))
      .returning();
    signal.throwIfAborted();

    if (!updated) {
      throw new Error("Failed to mark timed-out computer-use command");
    }

    await insertComputerUseCommandAuditEvent(tx, {
      command: updated,
      event: "completed",
      error,
      createdAt: params.now,
    });
    signal.throwIfAborted();
  }
}

function resolveComputerUseCommandTargets(params: {
  readonly onlineHosts: readonly ComputerUseHostRow[];
  readonly kind: ComputerUseCommandKind;
  readonly payload: Record<string, unknown>;
  readonly targetHostId?: string;
}): ResolveComputerUseCommandTargetsResult {
  if (params.onlineHosts.length === 0) {
    return { status: "host_offline" };
  }

  const candidates = params.targetHostId
    ? params.onlineHosts.filter((host) => {
        return host.id === params.targetHostId;
      })
    : params.onlineHosts;
  if (candidates.length === 0) {
    return { status: "host_offline" };
  }

  const supported = candidates.filter((host) => {
    return hostSupportsCommand({
      host,
      kind: params.kind,
      payload: params.payload,
    });
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

export const startComputerUseHost$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly installationId?: string;
      readonly hostName: string;
      readonly appVersion: string;
      readonly osVersion: string;
      readonly supportedCapabilities: readonly string[];
      readonly permissions: ComputerUseHostRow["permissions"];
    },
    signal: AbortSignal,
  ): Promise<StartComputerUseHostResult> => {
    const db = set(writeDb$);
    const hostToken = generateOpaqueToken("vm0_computer_use_host");
    const now = nowDate();
    const result = await db.transaction(async (tx) => {
      const displayName = normalizeHostName(params.hostName);
      const tokenHash = hashSecret(hostToken);
      const appVersion = normalizeVersion(params.appVersion);
      const osVersion = normalizeOsVersion(params.osVersion);
      const supportedCapabilities = normalizeCapabilities(
        params.supportedCapabilities,
      );
      const values = {
        orgId: params.orgId,
        userId: params.userId,
        installationId: params.installationId ?? null,
        displayName,
        tokenHash,
        appVersion,
        osVersion,
        supportedCapabilities,
        permissions: params.permissions,
        status: "online",
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      };
      const [host] = params.installationId
        ? await tx
            .insert(computerUseHosts)
            .values(values)
            .onConflictDoUpdate({
              target: [
                computerUseHosts.orgId,
                computerUseHosts.userId,
                computerUseHosts.installationId,
              ],
              targetWhere: sql`installation_id IS NOT NULL AND revoked_at IS NULL`,
              set: {
                displayName,
                tokenHash,
                appVersion,
                osVersion,
                supportedCapabilities,
                permissions: params.permissions,
                status: "online",
                lastSeenAt: now,
                updatedAt: now,
              },
            })
            .returning({ id: computerUseHosts.id })
        : await tx
            .insert(computerUseHosts)
            .values(values)
            .returning({ id: computerUseHosts.id });
      signal.throwIfAborted();

      if (!host) {
        throw new Error("Failed to start computer-use host");
      }

      return { status: "started" as const, hostId: host.id, hostToken };
    });
    signal.throwIfAborted();
    await publishComputerUseHostsChanged(params.userId);
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
      readonly permissions: ComputerUseHostRow["permissions"];
    },
    signal: AbortSignal,
  ): Promise<HeartbeatComputerUseHostResult> => {
    const db = set(writeDb$);
    const now = nowDate();
    const { result, publishChanged, userId } = await db.transaction(
      async (tx) => {
        const lockedHost = await hostFromToken(tx, params.hostToken, signal);
        if (!lockedHost) {
          return {
            result: { status: "invalid_token" as const },
            publishChanged: false,
            userId: null,
          };
        }
        const displayName = normalizeHostName(params.hostName);
        const appVersion = normalizeVersion(params.appVersion);
        const osVersion = normalizeOsVersion(params.osVersion);
        const supportedCapabilities = normalizeCapabilities(
          params.supportedCapabilities,
        );
        const publishChanged =
          !computerUseHostIsOnline(lockedHost, now) ||
          lockedHost.displayName !== displayName ||
          lockedHost.appVersion !== appVersion ||
          lockedHost.osVersion !== osVersion ||
          !sameStringArray(
            lockedHost.supportedCapabilities,
            supportedCapabilities,
          ) ||
          !samePermissions(lockedHost.permissions, params.permissions);

        await tx
          .update(computerUseHosts)
          .set({
            displayName,
            appVersion,
            osVersion,
            supportedCapabilities,
            permissions: params.permissions,
            status: "online",
            lastSeenAt: now,
            updatedAt: now,
          })
          .where(eq(computerUseHosts.id, lockedHost.id));
        signal.throwIfAborted();
        return {
          result: { status: "ok" as const, hostId: lockedHost.id },
          publishChanged,
          userId: lockedHost.userId,
        };
      },
    );
    signal.throwIfAborted();
    if (result.status === "ok" && publishChanged && userId) {
      await publishComputerUseHostsChanged(userId);
      signal.throwIfAborted();
    }
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
    const { result, userId } = await db.transaction(async (tx) => {
      const host = await hostFromToken(tx, params.hostToken, signal);
      if (!host) {
        return {
          result: { status: "invalid_token" as const },
          userId: null,
        };
      }

      if (host.installationId) {
        await tx
          .update(computerUseHosts)
          .set({
            status: "offline",
            tokenHash: invalidatedHostTokenHash(),
            updatedAt: now,
          })
          .where(eq(computerUseHosts.id, host.id));
      } else {
        await tx
          .update(computerUseHosts)
          .set({ status: "offline", revokedAt: now, updatedAt: now })
          .where(eq(computerUseHosts.id, host.id));
        await clearComputerUseHostThreadBindings({
          tx,
          userId: host.userId,
          hostId: host.id,
        });
      }
      signal.throwIfAborted();
      return {
        result: { status: "stopped" as const, hostId: host.id },
        userId: host.userId,
      };
    });
    signal.throwIfAborted();
    if (userId) {
      await publishComputerUseHostsChanged(userId);
      signal.throwIfAborted();
    }
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
    const result = await db.transaction(async (tx) => {
      const [host] = await tx
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
      if (!host) {
        return { status: "not_found" as const };
      }
      await clearComputerUseHostThreadBindings({
        tx,
        userId: params.userId,
        hostId: host.id,
      });
      return { status: "deleted" as const };
    });
    signal.throwIfAborted();
    if (result.status === "deleted") {
      await publishComputerUseHostsChanged(params.userId);
      signal.throwIfAborted();
    }
    return result;
  },
);

export const createComputerUseCommand$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly runId?: string;
      readonly targetHostId?: string;
      readonly kind: ComputerUseCommandKind;
      readonly payload: ComputerUseCommandPayload;
      readonly timeoutMs?: number;
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
      return computerUseHostIsOnline(host, now);
    });
    const payload = commandPayload(params.payload);
    const target = resolveComputerUseCommandTargets({
      onlineHosts,
      kind: params.kind,
      payload,
      targetHostId: params.targetHostId,
    });
    if (target.status !== "resolved") {
      return target;
    }

    const [row] = await db
      .insert(computerUseCommands)
      .values({
        orgId: params.orgId,
        userId: params.userId,
        runId: params.runId ?? null,
        hostId: target.targetHostId,
        kind: params.kind,
        status: "queued",
        payload,
        timeoutMs: params.timeoutMs,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    signal.throwIfAborted();

    if (!row) {
      throw new Error("Failed to create computer-use command");
    }

    return {
      status: "created",
      commandId: row.id,
      commandStatus: "queued",
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
      readonly hostId?: string;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const now = nowDate();
    const row = await db.transaction(async (tx) => {
      await failStaleRunningComputerUseCommands(
        tx,
        { orgId: params.orgId, userId: params.userId, now },
        signal,
      );
      const [commandRow] = await tx
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
            ...(params.hostId
              ? [eq(computerUseCommands.hostId, params.hostId)]
              : []),
          ),
        )
        .limit(1);
      return commandRow;
    });
    signal.throwIfAborted();
    return row ? serializeCommand(row.command, row.hostName) : null;
  },
);

export const getComputerUseCommandScreenshot$ = command(
  async (
    { get, set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly commandId: string;
      readonly hostId?: string;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly buffer: Buffer;
    readonly contentType: string;
  } | null> => {
    const db = set(writeDb$);
    const [row] = await db
      .select({
        status: computerUseCommands.status,
        result: computerUseCommands.result,
      })
      .from(computerUseCommands)
      .where(
        and(
          eq(computerUseCommands.orgId, params.orgId),
          eq(computerUseCommands.userId, params.userId),
          eq(computerUseCommands.id, params.commandId),
          ...(params.hostId
            ? [eq(computerUseCommands.hostId, params.hostId)]
            : []),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!row || row.status !== "succeeded" || !row.result) {
      return null;
    }

    const screenshot = row.result.screenshot;
    if (isStoredScreenshotPointer(screenshot)) {
      const buffer = await get(
        downloadS3Buffer(screenshot.bucket, screenshot.key),
      );
      signal.throwIfAborted();
      return { buffer, contentType: screenshot.mimeType };
    }
    if (typeof screenshot === "string") {
      const parsed = parseScreenshotDataUrl(screenshot);
      if (parsed) {
        return { buffer: parsed.buffer, contentType: parsed.mimeType };
      }
    }
    return null;
  },
);

export const getComputerUseCommandPluginContent$ = command(
  async (
    { get, set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly commandId: string;
      readonly hostId?: string;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly buffer: Buffer;
    readonly contentType: string;
    readonly fileName: string;
  } | null> => {
    const db = set(writeDb$);
    const [row] = await db
      .select({
        status: computerUseCommands.status,
        result: computerUseCommands.result,
      })
      .from(computerUseCommands)
      .where(
        and(
          eq(computerUseCommands.orgId, params.orgId),
          eq(computerUseCommands.userId, params.userId),
          eq(computerUseCommands.id, params.commandId),
          ...(params.hostId
            ? [eq(computerUseCommands.hostId, params.hostId)]
            : []),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!row || row.status !== "succeeded" || !row.result) {
      return null;
    }

    const pluginContent = row.result.pluginContent;
    if (!isStoredPluginContentPointer(pluginContent)) {
      return null;
    }

    const buffer = await get(
      downloadS3Buffer(pluginContent.bucket, pluginContent.key),
    );
    signal.throwIfAborted();
    return {
      buffer,
      contentType: pluginContent.mimeType,
      fileName: pluginContent.fileName,
    };
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

      await failStaleRunningComputerUseCommands(
        tx,
        {
          orgId: host.orgId,
          userId: host.userId,
          hostId: host.id,
          now,
        },
        signal,
      );

      const [runningCommand] = await tx
        .select({ id: computerUseCommands.id })
        .from(computerUseCommands)
        .where(
          and(
            eq(computerUseCommands.orgId, host.orgId),
            eq(computerUseCommands.userId, host.userId),
            eq(computerUseCommands.hostId, host.id),
            eq(computerUseCommands.status, "running"),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (runningCommand) {
        return { status: "idle" as const };
      }

      const effectiveCapabilities =
        capabilities.length > 0 ? capabilities : host.supportedCapabilities;
      const candidateRows = await tx
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
            inArray(computerUseCommands.kind, COMPUTER_USE_COMMANDS),
          ),
        )
        .orderBy(asc(computerUseCommands.createdAt))
        .for("update", { skipLocked: true })
        .limit(50);
      signal.throwIfAborted();

      const hostWithEffectiveCapabilities = {
        ...host,
        supportedCapabilities: effectiveCapabilities,
      };
      const row = candidateRows.find((candidate) => {
        return hostSupportsCommand({
          host: hostWithEffectiveCapabilities,
          kind: candidate.kind as ComputerUseCommandKind,
          payload: candidate.payload,
        });
      });

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

async function computerUseHostCommandCompletionState(
  tx: ComputerUseTx,
  params: {
    readonly hostToken: string;
    readonly commandId: string;
    readonly now: Date;
  },
  signal: AbortSignal,
): Promise<CompleteComputerUseHostCommandState> {
  const host = await hostFromToken(tx, params.hostToken, signal);
  if (!host) {
    return { status: "invalid_token" };
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
    return { status: "not_found" };
  }
  if (commandRow.status === "succeeded" || commandRow.status === "failed") {
    await tx
      .update(computerUseHosts)
      .set({ status: "online", lastSeenAt: params.now, updatedAt: params.now })
      .where(eq(computerUseHosts.id, host.id));
    signal.throwIfAborted();

    return { status: "completed" };
  }
  if (commandRow.status !== "running") {
    return { status: "not_running" };
  }

  return { status: "running", host };
}

export const completeComputerUseHostCommand$ = command(
  async (
    { get, set },
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
    const commandState = await db.transaction(async (tx) => {
      return await computerUseHostCommandCompletionState(
        tx,
        {
          hostToken: params.hostToken,
          commandId: params.commandId,
          now,
        },
        signal,
      );
    });
    signal.throwIfAborted();
    if (commandState.status !== "running") {
      return commandState;
    }

    let storedResult: ComputerUseCommandResult | null = null;
    if (params.status === "succeeded") {
      storedResult = await get(
        offloadScreenshotForResult(
          db,
          {
            hostToken: params.hostToken,
            commandId: params.commandId,
            result: params.result,
          },
          signal,
        ),
      );
      storedResult = await get(
        offloadPluginContentForResult(
          db,
          {
            hostToken: params.hostToken,
            commandId: params.commandId,
            result: storedResult,
          },
          signal,
        ),
      );
    }
    const storageError = commandErrorFromResult(storedResult);
    const completedAt = nowDate();
    const result = await db.transaction(async (tx) => {
      const currentState = await computerUseHostCommandCompletionState(
        tx,
        {
          hostToken: params.hostToken,
          commandId: params.commandId,
          now: completedAt,
        },
        signal,
      );
      if (currentState.status !== "running") {
        return currentState;
      }

      const finalError =
        storageError ?? (params.status === "failed" ? params.error : null);
      const finalStatus = finalError ? "failed" : params.status;
      const commandResult =
        finalStatus === "succeeded"
          ? (storedResult ?? params.result)
          : { error: finalError };
      const [updated] = await tx
        .update(computerUseCommands)
        .set({
          status: finalStatus,
          result: commandResult,
          error: finalStatus === "failed" ? finalError?.code : null,
          completedAt,
          updatedAt: completedAt,
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
        result: finalStatus === "succeeded" ? storedResult : null,
        error: finalStatus === "failed" ? finalError : null,
        createdAt: completedAt,
      });
      signal.throwIfAborted();

      await tx
        .update(computerUseHosts)
        .set({
          status: "online",
          lastSeenAt: completedAt,
          updatedAt: completedAt,
        })
        .where(eq(computerUseHosts.id, currentState.host.id));
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
          kind: row.kind as ComputerUseCommandKind,
          app: row.app,
          event: row.event as "completed",
          redactedResult: row.redactedResult,
          error: row.error,
          createdAt: row.createdAt.toISOString(),
        };
      }),
    };
  },
);
