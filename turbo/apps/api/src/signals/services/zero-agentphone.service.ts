import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { gzipSync } from "node:zlib";

import { command, computed, type Computed } from "ccstate";
import {
  getCanonicalModelDisplayName,
  getVm0VisibleModels,
  isSupportedRunModel,
  normalizeRunModelId,
  type SupportedRunModel,
} from "@vm0/api-contracts/contracts/model-providers";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { agentphoneMessages } from "@vm0/db/schema/agentphone-message";
import { agentphoneThreadSessions } from "@vm0/db/schema/agentphone-thread-session";
import { agentphoneUserAgentPreferences } from "@vm0/db/schema/agentphone-user-agent-preference";
import { agentphoneUserLinks } from "@vm0/db/schema/agentphone-user-link";
import { and, desc, eq, isNotNull } from "drizzle-orm";

import { env, optionalEnv } from "../../lib/env";
import { internalApiBaseUrl } from "../../lib/internal-api-url";
import { inferMimetype } from "../../lib/mimetype";
import { logger } from "../../lib/log";
import { now, nowDate } from "../external/time";
import { publishUserSignal } from "../external/realtime";
import { putS3Object } from "../external/s3";
import { writeDb$, type Db, type ReadonlyDb } from "../external/db";
import {
  sendAgentPhoneMessage,
  sendAgentPhoneTypingIndicator,
} from "../external/agentphone-client";
import { safeUrlParse, settle } from "../utils";
import { canReuseIntegrationSessionForModelRoute } from "./integration-session-model-compatibility.service";
import { formatIntegrationRunError$ } from "./integration-run-errors.service";
import {
  resolveIntegrationModelRouteForUser$,
  type IntegrationModelRoutePin,
} from "./integration-model-route.service";
import { createZeroRun$ } from "./zero-runs-create.service";
import { userFeatureSwitchOverrides } from "./feature-switches.service";
import { computeContentHashFromHashes } from "./storage-content-hash.service";
import { listOrgModelPolicies$ } from "./zero-model-policy.service";
import {
  updateUserModelPreference$,
  userModelPreference,
} from "./zero-user-data.service";

const log = logger("api:agentphone");
const MAX_CONNECT_AGE_SECONDS = 600;
const MAX_WEBHOOK_AGE_SECONDS = 300;
const SIGNATURE_PREFIX = "sha256=";
const MAX_CONTEXT_MESSAGES = 10;
const AGENTPHONE_SMS_MMS_SLASH_COMMAND_RISK_MESSAGE =
  "Note: SMS and MMS replies may not be delivered reliably. For the most reliable experience, use iMessage with this AgentPhone number.";
const AGENTPHONE_GROUP_CONNECT_IN_DM_MESSAGE =
  "To connect this phone number, message Zero directly in a 1:1 iMessage conversation.";
const AGENTPHONE_GROUP_ACCOUNT_COMMAND_MESSAGE =
  "Only the linked sender can use AgentPhone account commands in a group. Message Zero directly to connect or manage your link.";

const AGENTPHONE_DM_ROOT_MESSAGE_ID = "dm";
export type AgentPhoneChannel = "imessage" | "sms" | "mms";
type AgentPhoneUserLink = typeof agentphoneUserLinks.$inferSelect;

export interface AgentPhoneRecentHistoryMessage {
  readonly messageId?: string | null;
  readonly content: string | null;
  readonly direction: string | null;
  readonly channel: string | null;
  readonly fromNumber?: string | null;
  readonly toNumber?: string | null;
  readonly at?: string | null;
}

export interface AgentPhoneMessageEvent {
  readonly webhookId: string | null;
  readonly channel: AgentPhoneChannel;
  readonly messageId: string;
  readonly conversationId: string | null;
  readonly isGroup: boolean;
  readonly mentioned: boolean;
  readonly agentphoneAgentId: string;
  readonly fromNumber: string;
  readonly toNumber: string;
  readonly body: string;
  readonly mediaUrl: string | null;
  readonly receivedAt: Date | null;
  readonly recentHistory: readonly AgentPhoneRecentHistoryMessage[];
}

interface AgentPhoneCallbackContext {
  readonly messageId: string;
  readonly conversationId: string | null;
  readonly channel: AgentPhoneChannel;
  readonly isGroup: boolean;
  readonly rootMessageId: string;
  readonly phoneHandle: string;
  readonly fromNumber: string;
  readonly toNumber: string;
  readonly userLinkId: string;
  readonly agentId: string;
  readonly agentphoneAgentId: string;
  readonly existingSessionId: string | null;
}

type LinkAgentPhoneUserResult =
  | { readonly ok: true; readonly userLink: AgentPhoneUserLink }
  | {
      readonly ok: false;
      readonly reason: "phone-handle-linked" | "vm0-org-linked" | "conflict";
      readonly userLink?: AgentPhoneUserLink;
    };

interface ThreadSessionLookup {
  readonly existingSessionId: string | undefined;
  readonly lastProcessedMessageId: string | undefined;
}

interface WorkspaceAgent {
  readonly composeId: string;
  readonly agentId: string;
  readonly name: string;
  readonly displayName: string | null;
}

interface RunAgentResult {
  readonly status: "accepted" | "queued" | "failed";
  readonly response?: string;
  readonly runId?: string;
}

type ModelRoutePin = IntegrationModelRoutePin;

const AGENTPHONE_EMAIL_HANDLE_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/u;
const AGENTPHONE_PHONE_HANDLE_PATTERN = /^\+[1-9]\d{7,14}$/u;

export function isAgentPhoneChannel(value: string): value is AgentPhoneChannel {
  return value === "imessage" || value === "sms" || value === "mms";
}

export function normalizeAgentPhoneHandle(
  handle: string,
  channel: AgentPhoneChannel,
): string {
  const trimmed = handle.trim();
  if (channel === "imessage" && AGENTPHONE_EMAIL_HANDLE_PATTERN.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return trimmed.replace(/[^\d+]/gu, "");
}

export function isValidAgentPhoneHandle(
  handle: string,
  channel: AgentPhoneChannel,
): boolean {
  if (channel === "imessage" && AGENTPHONE_EMAIL_HANDLE_PATTERN.test(handle)) {
    return true;
  }
  return AGENTPHONE_PHONE_HANDLE_PATTERN.test(handle);
}

export function describeAgentPhoneHandleShape(
  handle: string,
): "email" | "phone" | "other" {
  const trimmed = handle.trim();
  if (AGENTPHONE_EMAIL_HANDLE_PATTERN.test(trimmed)) {
    return "email";
  }
  if (/^\+?\d+$/u.test(trimmed)) {
    return "phone";
  }
  return "other";
}

function isAgentPhoneGroupEvent(event: AgentPhoneMessageEvent): boolean {
  return event.channel === "imessage" && event.isGroup;
}

function agentPhoneThreadRootMessageId(event: AgentPhoneMessageEvent): string {
  if (!isAgentPhoneGroupEvent(event) || !event.conversationId) {
    return AGENTPHONE_DM_ROOT_MESSAGE_ID;
  }

  const root = `group:${event.conversationId}`;
  if (root.length <= 255) {
    return root;
  }

  return `group:${createHash("sha256")
    .update(event.conversationId)
    .digest("hex")}`;
}

function shouldIgnoreAgentPhoneGroupMessage(
  event: AgentPhoneMessageEvent,
): boolean {
  return isAgentPhoneGroupEvent(event) && !event.mentioned;
}

function isAgentPhoneGroupAccountCommand(
  event: AgentPhoneMessageEvent,
  commandName: string | undefined,
): boolean {
  return (
    isAgentPhoneGroupEvent(event) &&
    (commandName === "connect" ||
      commandName === "disconnect" ||
      commandName === "new_session" ||
      commandName === "model")
  );
}

function stripZeroMention(text: string): string {
  return text
    .replace(/(^|\s)@(zero|vm0)\b/giu, " ")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

function normalizeHandleForConnect(handle: string): string {
  return handle.trim();
}

export function signAgentPhoneConnectParams(params: {
  readonly phoneHandle: string;
  readonly agentphoneAgentId: string;
  readonly timestamp: number;
  readonly channel: AgentPhoneChannel;
  readonly secret: string;
}): string {
  return createHmac("sha256", params.secret)
    .update(
      `${normalizeHandleForConnect(params.phoneHandle)}:${
        params.agentphoneAgentId
      }:${String(params.timestamp)}:${params.channel}`,
    )
    .digest("hex");
}

export function verifyAgentPhoneConnectSignature(params: {
  readonly phoneHandle: string;
  readonly agentphoneAgentId: string;
  readonly timestamp: number;
  readonly channel: AgentPhoneChannel;
  readonly signature: string;
  readonly secret: string;
}): boolean {
  const nowSeconds = Math.floor(now() / 1000);
  if (Math.abs(nowSeconds - params.timestamp) > MAX_CONNECT_AGE_SECONDS) {
    return false;
  }

  const expected = signAgentPhoneConnectParams({
    phoneHandle: params.phoneHandle,
    agentphoneAgentId: params.agentphoneAgentId,
    timestamp: params.timestamp,
    channel: params.channel,
    secret: params.secret,
  });
  if (!/^[0-9a-f]+$/iu.test(params.signature)) {
    return false;
  }

  const expectedBuffer = Buffer.from(expected, "hex");
  const signatureBuffer = Buffer.from(params.signature, "hex");
  if (expectedBuffer.length !== signatureBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, signatureBuffer);
}

export function verifyAgentPhoneWebhook(params: {
  readonly rawBody: string;
  readonly signature: string | null;
  readonly timestamp: string | null;
  readonly secret: string;
}): boolean {
  if (!params.signature || !params.timestamp) {
    return false;
  }

  const timestamp = Number(params.timestamp);
  if (!Number.isFinite(timestamp)) {
    return false;
  }

  const nowSeconds = Math.floor(now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > MAX_WEBHOOK_AGE_SECONDS) {
    return false;
  }

  const expectedDigest = createHmac("sha256", params.secret)
    .update(`${params.timestamp}.${params.rawBody}`)
    .digest("hex");
  const expected = `${SIGNATURE_PREFIX}${expectedDigest}`;
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(params.signature);
  if (expectedBuffer.length !== signatureBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, signatureBuffer);
}

export function buildAgentPhoneConnectUrl(params: {
  readonly phoneHandle: string;
  readonly agentphoneAgentId: string;
  readonly channel: AgentPhoneChannel;
  readonly secret: string;
}): string {
  const timestamp = Math.floor(now() / 1000);
  const phoneHandle = normalizeAgentPhoneHandle(
    params.phoneHandle,
    params.channel,
  );
  const query = new URLSearchParams({
    handle: phoneHandle,
    agent: params.agentphoneAgentId,
    ts: String(timestamp),
    sig: signAgentPhoneConnectParams({
      phoneHandle,
      agentphoneAgentId: params.agentphoneAgentId,
      timestamp,
      channel: params.channel,
      secret: params.secret,
    }),
    channel: params.channel,
  });
  return `${env("APP_URL").replace(/\/$/u, "")}/agentphone/connect?${query.toString()}`;
}

function createEmptyTarGz(): Buffer {
  return gzipSync(Buffer.alloc(1024, 0));
}

export const ensureAgentPhoneArtifactStorage$ = command(
  async (
    { get, set },
    args: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    const [storage] = await writeDb
      .insert(storages)
      .values({
        name: "artifact",
        type: "artifact",
        userId: args.userId,
        s3Prefix: `${args.orgId}/artifact/artifact`,
        size: 0,
        fileCount: 0,
        orgId: args.orgId,
      })
      .onConflictDoNothing()
      .returning();
    signal.throwIfAborted();

    const [currentStorage] = storage
      ? [storage]
      : await writeDb
          .select()
          .from(storages)
          .where(
            and(
              eq(storages.orgId, args.orgId),
              eq(storages.userId, args.userId),
              eq(storages.name, "artifact"),
              eq(storages.type, "artifact"),
            ),
          )
          .limit(1);
    signal.throwIfAborted();

    if (!currentStorage || currentStorage.headVersionId) {
      return;
    }

    const versionId = computeContentHashFromHashes(currentStorage.id, []);
    const s3Key = `${currentStorage.s3Prefix}/${versionId}`;
    const bucketName = env("R2_USER_STORAGES_BUCKET_NAME");

    await Promise.all([
      get(
        putS3Object(
          bucketName,
          `${s3Key}/manifest.json`,
          JSON.stringify({ files: [] }),
          "application/json",
        ),
      ),
      get(
        putS3Object(
          bucketName,
          `${s3Key}/archive.tar.gz`,
          createEmptyTarGz(),
          "application/gzip",
        ),
      ),
    ]);
    signal.throwIfAborted();

    await writeDb.transaction(async (tx) => {
      await tx
        .insert(storageVersions)
        .values({
          id: versionId,
          storageId: currentStorage.id,
          s3Key,
          size: 0,
          fileCount: 0,
          message: "Initial empty artifact (auto-created)",
          createdBy: "user",
        })
        .onConflictDoNothing();

      await tx
        .update(storages)
        .set({
          headVersionId: versionId,
          size: 0,
          fileCount: 0,
          updatedAt: nowDate(),
        })
        .where(eq(storages.id, currentStorage.id));
    });
    signal.throwIfAborted();
  },
);

async function touchAgentPhoneUserLink(
  db: Db,
  userLink: AgentPhoneUserLink,
  phoneHandle: string,
  channel: AgentPhoneChannel,
): Promise<AgentPhoneUserLink> {
  const normalized = normalizeAgentPhoneHandle(phoneHandle, channel);
  if (userLink.phoneHandle === normalized) {
    return userLink;
  }

  const [updated] = await db
    .update(agentphoneUserLinks)
    .set({ phoneHandle: normalized, updatedAt: nowDate() })
    .where(eq(agentphoneUserLinks.id, userLink.id))
    .returning();

  return updated ?? userLink;
}

export async function linkAgentPhoneUserToVm0User(
  db: Db,
  params: {
    readonly phoneHandle: string;
    readonly channel: AgentPhoneChannel;
    readonly vm0UserId: string;
    readonly orgId: string;
  },
): Promise<LinkAgentPhoneUserResult> {
  const phoneHandle = normalizeAgentPhoneHandle(
    params.phoneHandle,
    params.channel,
  );
  const [existingPhoneLink] = await db
    .select()
    .from(agentphoneUserLinks)
    .where(eq(agentphoneUserLinks.phoneHandle, phoneHandle))
    .limit(1);

  if (existingPhoneLink) {
    if (
      existingPhoneLink.vm0UserId === params.vm0UserId &&
      existingPhoneLink.orgId === params.orgId
    ) {
      return {
        ok: true,
        userLink: await touchAgentPhoneUserLink(
          db,
          existingPhoneLink,
          phoneHandle,
          params.channel,
        ),
      };
    }

    return {
      ok: false,
      reason: "phone-handle-linked",
      userLink: existingPhoneLink,
    };
  }

  const [existingVm0OrgLink] = await db
    .select()
    .from(agentphoneUserLinks)
    .where(
      and(
        eq(agentphoneUserLinks.vm0UserId, params.vm0UserId),
        eq(agentphoneUserLinks.orgId, params.orgId),
      ),
    )
    .limit(1);

  if (existingVm0OrgLink) {
    if (existingVm0OrgLink.phoneHandle === phoneHandle) {
      return {
        ok: true,
        userLink: await touchAgentPhoneUserLink(
          db,
          existingVm0OrgLink,
          phoneHandle,
          params.channel,
        ),
      };
    }

    return {
      ok: false,
      reason: "vm0-org-linked",
      userLink: existingVm0OrgLink,
    };
  }

  const [inserted] = await db
    .insert(agentphoneUserLinks)
    .values({
      phoneHandle,
      vm0UserId: params.vm0UserId,
      orgId: params.orgId,
    })
    .onConflictDoNothing()
    .returning();

  if (inserted) {
    return { ok: true, userLink: inserted };
  }
  return { ok: false, reason: "conflict" };
}

export async function resolveAgentPhoneUserLink(
  db: Db,
  phoneHandle: string,
  channel: AgentPhoneChannel,
): Promise<AgentPhoneUserLink | null> {
  const normalized = normalizeAgentPhoneHandle(phoneHandle, channel);
  if (!normalized) {
    return null;
  }
  const [userLink] = await db
    .select()
    .from(agentphoneUserLinks)
    .where(eq(agentphoneUserLinks.phoneHandle, normalized))
    .limit(1);

  if (!userLink) {
    return null;
  }
  return touchAgentPhoneUserLink(db, userLink, normalized, channel);
}

async function resolveAgentPhoneUserLinkById(
  db: ReadonlyDb,
  userLinkId: string,
): Promise<AgentPhoneUserLink | null> {
  const [userLink] = await db
    .select()
    .from(agentphoneUserLinks)
    .where(eq(agentphoneUserLinks.id, userLinkId))
    .limit(1);
  return userLink ?? null;
}

async function resolveAgentPhoneConversationUserLink(
  db: ReadonlyDb,
  conversationId: string,
): Promise<AgentPhoneUserLink | null> {
  const [session] = await db
    .select({ userLinkId: agentphoneThreadSessions.agentphoneUserLinkId })
    .from(agentphoneThreadSessions)
    .where(eq(agentphoneThreadSessions.conversationId, conversationId))
    .orderBy(desc(agentphoneThreadSessions.updatedAt))
    .limit(1);
  if (session) {
    return resolveAgentPhoneUserLinkById(db, session.userLinkId);
  }

  const [message] = await db
    .select({ userLinkId: agentphoneMessages.agentphoneUserLinkId })
    .from(agentphoneMessages)
    .where(
      and(
        eq(agentphoneMessages.conversationId, conversationId),
        isNotNull(agentphoneMessages.agentphoneUserLinkId),
      ),
    )
    .orderBy(desc(agentphoneMessages.createdAt))
    .limit(1);
  return message?.userLinkId
    ? resolveAgentPhoneUserLinkById(db, message.userLinkId)
    : null;
}

export async function resolveAgentPhoneUserLinkForEvent(
  db: Db,
  event: AgentPhoneMessageEvent,
): Promise<AgentPhoneUserLink | null> {
  const direct = await resolveAgentPhoneUserLink(
    db,
    event.fromNumber,
    event.channel,
  );
  if (direct || !isAgentPhoneGroupEvent(event) || !event.conversationId) {
    return direct;
  }

  return resolveAgentPhoneConversationUserLink(db, event.conversationId);
}

export async function resolveAgentPhoneUserLinkForOwner(
  db: Db,
  params: {
    readonly phoneHandle: string;
    readonly channel: AgentPhoneChannel;
    readonly vm0UserId: string;
    readonly orgId: string;
  },
): Promise<AgentPhoneUserLink | null> {
  const normalized = normalizeAgentPhoneHandle(
    params.phoneHandle,
    params.channel,
  );
  if (!normalized) {
    return null;
  }
  const [userLink] = await db
    .select()
    .from(agentphoneUserLinks)
    .where(
      and(
        eq(agentphoneUserLinks.phoneHandle, normalized),
        eq(agentphoneUserLinks.vm0UserId, params.vm0UserId),
        eq(agentphoneUserLinks.orgId, params.orgId),
      ),
    )
    .limit(1);

  if (!userLink) {
    return null;
  }
  return touchAgentPhoneUserLink(db, userLink, normalized, params.channel);
}

export async function resolveAgentPhoneAgentIdForUserLink(
  db: ReadonlyDb,
  params: {
    readonly userLinkId: string;
    readonly phoneHandle: string;
    readonly channel: AgentPhoneChannel;
    readonly agentphoneAgentId?: string | null;
  },
): Promise<string | null> {
  if (params.agentphoneAgentId) {
    return params.agentphoneAgentId;
  }

  const [message] = await db
    .select({ agentphoneAgentId: agentphoneMessages.agentphoneAgentId })
    .from(agentphoneMessages)
    .where(
      and(
        eq(agentphoneMessages.agentphoneUserLinkId, params.userLinkId),
        eq(
          agentphoneMessages.phoneHandle,
          normalizeAgentPhoneHandle(params.phoneHandle, params.channel),
        ),
      ),
    )
    .orderBy(desc(agentphoneMessages.createdAt))
    .limit(1);

  return message?.agentphoneAgentId ?? null;
}

export async function storeInboundAgentPhoneMessage(
  db: Db,
  params: {
    readonly event: AgentPhoneMessageEvent;
    readonly userLinkId?: string | null;
  },
): Promise<{ readonly inserted: boolean }> {
  const inserted = await db
    .insert(agentphoneMessages)
    .values({
      webhookId: params.event.webhookId,
      agentphoneMessageId: params.event.messageId,
      conversationId: params.event.conversationId,
      agentphoneAgentId: params.event.agentphoneAgentId,
      agentphoneUserLinkId: params.userLinkId ?? null,
      phoneHandle: normalizeAgentPhoneHandle(
        params.event.fromNumber,
        params.event.channel,
      ),
      fromNumber: normalizeAgentPhoneHandle(
        params.event.fromNumber,
        params.event.channel,
      ),
      toNumber: normalizeAgentPhoneHandle(params.event.toNumber, "sms"),
      direction: "inbound",
      channel: params.event.channel,
      body: params.event.body || null,
      mediaUrl: params.event.mediaUrl,
      isBot: false,
      receivedAt: params.event.receivedAt,
    })
    .onConflictDoNothing()
    .returning({ id: agentphoneMessages.id });

  return { inserted: inserted.length > 0 };
}

export async function storeOutboundAgentPhoneMessage(
  db: Db,
  params: {
    readonly agentphoneMessageId: string;
    readonly conversationId: string | null;
    readonly agentphoneAgentId: string;
    readonly userLinkId: string;
    readonly phoneHandle: string;
    readonly fromNumber: string;
    readonly toNumber: string;
    readonly body: string | undefined;
    readonly channel: string | null;
    readonly userChannel: AgentPhoneChannel;
    readonly mediaUrl?: string | null;
  },
): Promise<void> {
  await db
    .insert(agentphoneMessages)
    .values({
      agentphoneMessageId: params.agentphoneMessageId,
      conversationId: params.conversationId,
      agentphoneAgentId: params.agentphoneAgentId,
      agentphoneUserLinkId: params.userLinkId,
      phoneHandle: normalizeAgentPhoneHandle(
        params.phoneHandle,
        params.userChannel,
      ),
      fromNumber: normalizeAgentPhoneHandle(params.fromNumber, "sms"),
      toNumber: normalizeAgentPhoneHandle(params.toNumber, params.userChannel),
      direction: "outbound",
      channel: params.channel ?? "unknown",
      body: params.body ?? null,
      mediaUrl: params.mediaUrl ?? null,
      isBot: true,
    })
    .onConflictDoNothing();
}

async function getAgentPhoneUserAgentPreference(
  db: ReadonlyDb,
  vm0UserId: string,
  orgId: string,
): Promise<string | null> {
  const [row] = await db
    .select({
      selectedComposeId: agentphoneUserAgentPreferences.selectedComposeId,
    })
    .from(agentphoneUserAgentPreferences)
    .where(
      and(
        eq(agentphoneUserAgentPreferences.vm0UserId, vm0UserId),
        eq(agentphoneUserAgentPreferences.orgId, orgId),
      ),
    )
    .limit(1);

  return row?.selectedComposeId ?? null;
}

async function resolveOrgDefaultComposeId(
  db: ReadonlyDb,
  orgId: string,
): Promise<string | null> {
  const [metadata] = await db
    .select({ defaultAgentId: orgMetadata.defaultAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return metadata?.defaultAgentId ?? null;
}

async function resolveEffectiveAgentPhoneComposeId(
  db: ReadonlyDb,
  vm0UserId: string,
  orgId: string,
): Promise<string | null> {
  const preference = await getAgentPhoneUserAgentPreference(
    db,
    vm0UserId,
    orgId,
  );
  if (preference) {
    const [compose] = await db
      .select({ id: agentComposes.id })
      .from(agentComposes)
      .where(
        and(eq(agentComposes.id, preference), eq(agentComposes.orgId, orgId)),
      )
      .limit(1);

    if (compose?.id) {
      return preference;
    }
  }

  return resolveOrgDefaultComposeId(db, orgId);
}

async function getWorkspaceAgent(
  db: ReadonlyDb,
  composeId: string,
): Promise<WorkspaceAgent | null> {
  const [row] = await db
    .select({
      composeId: agentComposes.id,
      name: zeroAgents.name,
      displayName: zeroAgents.displayName,
    })
    .from(agentComposes)
    .innerJoin(zeroAgents, eq(zeroAgents.id, agentComposes.id))
    .where(eq(agentComposes.id, composeId))
    .limit(1);

  if (!row) {
    return null;
  }

  return {
    composeId: row.composeId,
    agentId: row.composeId,
    name: row.name,
    displayName: row.displayName,
  };
}

async function resolveAgentPhoneAgent(
  db: ReadonlyDb,
  userLink: AgentPhoneUserLink,
): Promise<WorkspaceAgent | undefined> {
  const composeId = await resolveEffectiveAgentPhoneComposeId(
    db,
    userLink.vm0UserId,
    userLink.orgId,
  );
  if (!composeId) {
    return undefined;
  }

  return (await getWorkspaceAgent(db, composeId)) ?? undefined;
}

async function lookupAgentPhoneThreadSession(
  db: ReadonlyDb,
  userLinkId: string,
  rootMessageId: string,
): Promise<ThreadSessionLookup> {
  const [session] = await db
    .select({
      agentSessionId: agentphoneThreadSessions.agentSessionId,
      lastProcessedMessageId: agentphoneThreadSessions.lastProcessedMessageId,
    })
    .from(agentphoneThreadSessions)
    .where(
      and(
        eq(agentphoneThreadSessions.agentphoneUserLinkId, userLinkId),
        eq(agentphoneThreadSessions.rootMessageId, rootMessageId),
      ),
    )
    .limit(1);

  return {
    existingSessionId: session?.agentSessionId,
    lastProcessedMessageId: session?.lastProcessedMessageId ?? undefined,
  };
}

async function resolveCompatibleAgentPhoneThreadSession(args: {
  readonly db: ReadonlyDb;
  readonly userLinkId: string;
  readonly userId: string;
  readonly agentComposeId: string;
  readonly rootMessageId: string;
  readonly modelRoute: ModelRoutePin | undefined;
}): Promise<ThreadSessionLookup> {
  const session = await lookupAgentPhoneThreadSession(
    args.db,
    args.userLinkId,
    args.rootMessageId,
  );
  if (!session.existingSessionId) {
    return session;
  }

  const [agentSession] = await args.db
    .select({
      agentComposeId: agentSessions.agentComposeId,
    })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, session.existingSessionId),
        eq(agentSessions.userId, args.userId),
      ),
    )
    .limit(1);
  if (agentSession?.agentComposeId !== args.agentComposeId) {
    return { existingSessionId: undefined, lastProcessedMessageId: undefined };
  }

  if (args.modelRoute) {
    const canReuseSession = await canReuseIntegrationSessionForModelRoute({
      db: args.db,
      sessionId: session.existingSessionId,
      modelRoute: args.modelRoute,
    });
    if (!canReuseSession) {
      return {
        existingSessionId: undefined,
        lastProcessedMessageId: undefined,
      };
    }
  }

  return session;
}

export async function saveAgentPhoneThreadSession(
  db: Db,
  opts: {
    readonly userLinkId: string;
    readonly conversationId: string | null;
    readonly rootMessageId: string;
    readonly existingSessionId: string | undefined;
    readonly newSessionId: string | undefined;
    readonly messageId: string;
    readonly runStatus: string;
  },
): Promise<void> {
  if (!opts.existingSessionId && opts.newSessionId) {
    const updated = await db
      .update(agentphoneThreadSessions)
      .set({
        agentSessionId: opts.newSessionId,
        conversationId: opts.conversationId,
        lastProcessedMessageId: opts.messageId,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(agentphoneThreadSessions.agentphoneUserLinkId, opts.userLinkId),
          eq(agentphoneThreadSessions.rootMessageId, opts.rootMessageId),
        ),
      )
      .returning({ id: agentphoneThreadSessions.id });

    if (updated.length > 0) {
      return;
    }

    await db
      .insert(agentphoneThreadSessions)
      .values({
        agentphoneUserLinkId: opts.userLinkId,
        conversationId: opts.conversationId,
        rootMessageId: opts.rootMessageId,
        agentSessionId: opts.newSessionId,
        lastProcessedMessageId: opts.messageId,
      })
      .onConflictDoNothing();
    return;
  }

  if (
    opts.existingSessionId &&
    (opts.runStatus === "completed" || opts.runStatus === "timeout")
  ) {
    await db
      .update(agentphoneThreadSessions)
      .set({
        conversationId: opts.conversationId,
        lastProcessedMessageId: opts.messageId,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(agentphoneThreadSessions.agentphoneUserLinkId, opts.userLinkId),
          eq(agentphoneThreadSessions.rootMessageId, opts.rootMessageId),
        ),
      );
  }
}

export function agentPhoneFilenameFromMediaUrl(
  mediaUrl: string,
  fallback: string,
): string {
  const url = safeUrlParse(mediaUrl);
  if (!url) {
    return fallback;
  }
  const filename = url.pathname.split("/").filter(Boolean).pop();
  return filename ? decodePathSegment(filename) : fallback;
}

function parseHexByte(input: string): number | undefined {
  return /^[0-9a-fA-F]{2}$/u.test(input)
    ? Number.parseInt(input, 16)
    : undefined;
}

function decodePathSegment(input: string): string {
  const decoder = new TextDecoder();
  let output = "";
  let index = 0;

  while (index < input.length) {
    const char = input[index];
    if (char !== "%") {
      output += char ?? "";
      index += 1;
      continue;
    }

    const bytes: number[] = [];
    let cursor = index;
    while (cursor + 2 < input.length && input[cursor] === "%") {
      const byte = parseHexByte(input.slice(cursor + 1, cursor + 3));
      if (byte === undefined) {
        break;
      }
      bytes.push(byte);
      cursor += 3;
    }

    if (bytes.length === 0) {
      output += "%";
      index += 1;
      continue;
    }

    output += decoder.decode(Uint8Array.from(bytes));
    index = cursor;
  }

  return output;
}

function formatAgentPhoneFileForContext(params: {
  readonly messageId: string;
  readonly mediaUrl: string;
}): string {
  const name = agentPhoneFilenameFromMediaUrl(
    params.mediaUrl,
    "agentphone-media",
  );
  const mimetype = inferMimetype(name);
  return [
    `[AgentPhone file] ${name} (${mimetype})`,
    `   [ID] ${params.messageId}`,
  ].join("\n");
}

async function fetchAgentPhoneContext(
  db: ReadonlyDb,
  params: {
    readonly userLinkId: string;
    readonly phoneHandle: string;
    readonly channel: AgentPhoneChannel;
    readonly conversationId: string | null;
    readonly isGroup: boolean;
    readonly recentHistory: readonly AgentPhoneRecentHistoryMessage[];
    readonly currentMessageId?: string;
  },
): Promise<{ readonly executionContext: string }> {
  const phoneHandle = normalizeAgentPhoneHandle(
    params.phoneHandle,
    params.channel,
  );
  const providerContext = formatAgentPhoneRecentHistoryContext(
    params.recentHistory,
    params.currentMessageId,
    params.isGroup,
  );
  if (providerContext) {
    return { executionContext: providerContext };
  }

  const messages =
    params.isGroup && params.conversationId
      ? await db
          .select({
            messageId: agentphoneMessages.agentphoneMessageId,
            body: agentphoneMessages.body,
            mediaUrl: agentphoneMessages.mediaUrl,
            isBot: agentphoneMessages.isBot,
            direction: agentphoneMessages.direction,
            fromNumber: agentphoneMessages.fromNumber,
          })
          .from(agentphoneMessages)
          .where(
            and(
              eq(agentphoneMessages.agentphoneUserLinkId, params.userLinkId),
              eq(agentphoneMessages.conversationId, params.conversationId),
            ),
          )
          .orderBy(desc(agentphoneMessages.createdAt))
          .limit(MAX_CONTEXT_MESSAGES)
      : await db
          .select({
            messageId: agentphoneMessages.agentphoneMessageId,
            body: agentphoneMessages.body,
            mediaUrl: agentphoneMessages.mediaUrl,
            isBot: agentphoneMessages.isBot,
            direction: agentphoneMessages.direction,
            fromNumber: agentphoneMessages.fromNumber,
          })
          .from(agentphoneMessages)
          .where(
            and(
              eq(agentphoneMessages.agentphoneUserLinkId, params.userLinkId),
              eq(agentphoneMessages.phoneHandle, phoneHandle),
            ),
          )
          .orderBy(desc(agentphoneMessages.createdAt))
          .limit(MAX_CONTEXT_MESSAGES);

  return {
    executionContext: formatAgentPhoneStoredContext({
      messages,
      currentMessageId: params.currentMessageId,
      fallbackSender: phoneHandle,
      isGroup: params.isGroup,
    }),
  };
}

function formatAgentPhoneStoredContext(params: {
  readonly messages: readonly {
    readonly messageId: string;
    readonly body: string | null;
    readonly mediaUrl: string | null;
    readonly isBot: boolean;
    readonly direction: string;
    readonly fromNumber: string;
  }[];
  readonly currentMessageId?: string;
  readonly fallbackSender: string;
  readonly isGroup: boolean;
}): string {
  const chronological = [...params.messages].reverse().filter((message) => {
    return (
      !params.currentMessageId || message.messageId !== params.currentMessageId
    );
  });
  if (chronological.length === 0) {
    return "";
  }

  const total = chronological.length;
  const formatted = chronological.map((message, index) => {
    const sender = message.isBot
      ? "BOT"
      : params.isGroup
        ? message.fromNumber
        : params.fallbackSender;
    const parts = [
      "---",
      "",
      `- RELATIVE_INDEX: ${index - total}`,
      `- MSG_ID: ${message.messageId}`,
      `- SENDER: {id: ${sender}}`,
      `- DIRECTION: ${message.direction}`,
      "",
      message.body ?? "",
    ];
    if (message.mediaUrl) {
      parts.push(
        "",
        formatAgentPhoneFileForContext({
          messageId: message.messageId,
          mediaUrl: message.mediaUrl,
        }),
      );
    }
    return parts.join("\n");
  });

  return buildAgentPhoneContextBlock(formatted, params.isGroup);
}

function formatAgentPhoneRecentHistoryContext(
  recentHistory: readonly AgentPhoneRecentHistoryMessage[],
  currentMessageId: string | undefined,
  isGroup: boolean,
): string {
  const chronological = recentHistory
    .filter((message) => {
      return !currentMessageId || message.messageId !== currentMessageId;
    })
    .slice(-MAX_CONTEXT_MESSAGES);

  if (chronological.length === 0) {
    return "";
  }

  const total = chronological.length;
  const formatted = chronological.map((message, index) => {
    const sender = message.fromNumber ?? message.direction ?? "unknown";
    return [
      "---",
      "",
      `- RELATIVE_INDEX: ${index - total}`,
      message.messageId ? `- MSG_ID: ${message.messageId}` : null,
      `- SENDER: {id: ${sender}}`,
      message.direction ? `- DIRECTION: ${message.direction}` : null,
      message.channel ? `- CHANNEL: ${message.channel}` : null,
      message.at ? `- AT: ${message.at}` : null,
      "",
      message.content ?? "",
    ]
      .filter((part): part is string => {
        return part !== null;
      })
      .join("\n");
  });

  return buildAgentPhoneContextBlock(formatted, isGroup);
}

function buildAgentPhoneContextBlock(
  formattedMessages: readonly string[],
  isGroup: boolean,
): string {
  return [
    "# AgentPhone Message Context",
    "",
    isGroup
      ? "The messages below are from an iMessage group conversation with the shared Zero number. Messages closer to RELATIVE_INDEX 0 are more recent."
      : "The messages below are from the user's text message conversation with the shared Zero number. Messages closer to RELATIVE_INDEX 0 are more recent.",
    "",
    formattedMessages.join("\n\n"),
    "",
    "---",
  ].join("\n");
}

function enrichAgentPhonePrompt(opts: {
  readonly prompt: string;
  readonly phoneHandle: string;
  readonly channel: AgentPhoneChannel;
  readonly messageId: string;
  readonly mediaUrl: string | null;
  readonly isGroup: boolean;
}): {
  readonly prompt: string;
  readonly userInfoExtras: { readonly agentphoneHandle: string };
} {
  const normalized = normalizeAgentPhoneHandle(opts.phoneHandle, opts.channel);
  const promptText = opts.isGroup
    ? stripZeroMention(opts.prompt)
    : opts.prompt.trim();
  const parts = [promptText];
  if (opts.mediaUrl) {
    parts.push(
      formatAgentPhoneFileForContext({
        messageId: opts.messageId,
        mediaUrl: opts.mediaUrl,
      }),
    );
  }
  return {
    prompt: parts.filter(Boolean).join("\n\n"),
    userInfoExtras: { agentphoneHandle: normalized },
  };
}

function buildIntegrationPrompt(platform: string): string {
  return `# Current Integration\nYou are currently running inside: ${platform}`;
}

function buildAgentPhonePrompt(
  opts: {
    readonly sharedNumber: string;
    readonly phoneHandle: string;
    readonly conversationId?: string | null;
    readonly channel?: string | null;
    readonly isGroup?: boolean;
    readonly messageId?: string;
    readonly agentphoneAgentId?: string;
  },
  threadContext: string,
): string {
  const headerParts = [buildIntegrationPrompt("AgentPhone")];
  headerParts.push(`Shared AgentPhone number: ${opts.sharedNumber}`);
  headerParts.push(`User phone handle: ${opts.phoneHandle}`);
  if (opts.agentphoneAgentId) {
    headerParts.push(`AgentPhone Agent ID: ${opts.agentphoneAgentId}`);
  }
  if (opts.channel) {
    headerParts.push(`Channel: ${opts.channel}`);
  }
  if (opts.isGroup !== undefined) {
    headerParts.push(`Conversation type: ${opts.isGroup ? "group" : "dm"}`);
  }
  if (opts.conversationId) {
    headerParts.push(`Conversation ID: ${opts.conversationId}`);
  }
  if (opts.messageId) {
    headerParts.push(`Message ID: ${opts.messageId}`);
  }
  return [headerParts.join("\n"), threadContext].filter(Boolean).join("\n\n");
}

function parseAgentPhoneCommand(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }
  const firstWord = trimmed.split(/\s/u)[0];
  if (!firstWord) {
    return undefined;
  }
  return firstWord.slice(1).toLowerCase();
}

function isUnreliableAgentPhoneReplyChannel(
  channel: string | null | undefined,
): boolean {
  const normalized = channel?.trim().toLowerCase();
  return normalized === "sms" || normalized === "mms";
}

function appendAgentPhoneSlashCommandRiskWarning(
  body: string,
  channel: string | null | undefined,
): string {
  if (!isUnreliableAgentPhoneReplyChannel(channel)) {
    return body;
  }
  if (body.includes(AGENTPHONE_SMS_MMS_SLASH_COMMAND_RISK_MESSAGE)) {
    return body;
  }
  return [body, AGENTPHONE_SMS_MMS_SLASH_COMMAND_RISK_MESSAGE].join("\n\n");
}

async function sendAgentPhoneText(
  event: AgentPhoneMessageEvent,
  body: string,
  signal: AbortSignal,
): Promise<void> {
  await sendAgentPhoneMessage(
    {
      agentphoneAgentId: event.agentphoneAgentId,
      ...(isAgentPhoneGroupEvent(event) && event.conversationId
        ? {
            conversationId: event.conversationId,
            replyToMessageId: event.messageId,
          }
        : { toNumber: event.fromNumber }),
      body,
    },
    signal,
  );
}

async function sendAgentPhoneSlashCommandText(
  event: AgentPhoneMessageEvent,
  body: string,
  signal: AbortSignal,
): Promise<void> {
  await sendAgentPhoneText(
    event,
    appendAgentPhoneSlashCommandRiskWarning(body, event.channel),
    signal,
  );
}

async function refreshTypingIfSupported(
  event: AgentPhoneMessageEvent,
  signal: AbortSignal,
): Promise<void> {
  if (event.channel !== "imessage" || !event.conversationId) {
    return;
  }
  const conversationId = event.conversationId;

  const result = await settle(
    sendAgentPhoneTypingIndicator({ conversationId }, signal),
  );
  if (!result.ok) {
    log.debug("Failed to send AgentPhone typing indicator", {
      conversationId: event.conversationId,
      error: result.error,
    });
  }
}

function formatConnectPrompt(event: AgentPhoneMessageEvent): string {
  const connectUrl = buildAgentPhoneConnectUrl({
    phoneHandle: event.fromNumber,
    agentphoneAgentId: event.agentphoneAgentId,
    secret: env("SECRETS_ENCRYPTION_KEY"),
    channel: event.channel,
  });

  return [
    "Hi, I'm Zero, your AI coworker from vm0.",
    "",
    "You can text me like a teammate and I'll actually do the work: research something, draft and send emails, summarize long documents, update spreadsheets, triage tickets, post to Slack, dig through your GitHub or Notion, and a lot more.",
    "",
    "I'm most useful once I'm connected to the tools you already use — GitHub, Gmail, Notion, Google Drive / Sheets / Docs / Calendar, Slack, Sentry, X, and 100+ others.",
    "",
    "Click the link below to start to use zero",
    "",
    connectUrl,
  ].join("\n");
}

function formatHelpMessage(): string {
  return [
    "Zero text message commands",
    "",
    "/connect - Connect this phone number to VM0",
    "/new_session - Start a new conversation",
    "/model - Choose your model",
    "/disconnect - Disconnect this phone number from VM0",
    "/help - Show these commands",
    "",
    "Send a message to chat with Zero after connecting.",
  ].join("\n");
}

async function sendConnectPrompt(
  event: AgentPhoneMessageEvent,
  options: { readonly slashCommand: boolean } | undefined,
  signal: AbortSignal,
): Promise<void> {
  const body = formatConnectPrompt(event);
  await sendAgentPhoneText(
    event,
    options?.slashCommand
      ? appendAgentPhoneSlashCommandRiskWarning(body, event.channel)
      : body,
    signal,
  );
}

async function sendGroupConnectInDmPrompt(
  event: AgentPhoneMessageEvent,
  signal: AbortSignal,
): Promise<void> {
  await sendAgentPhoneText(
    event,
    AGENTPHONE_GROUP_CONNECT_IN_DM_MESSAGE,
    signal,
  );
}

async function sendGroupAccountCommandBlockedMessage(
  event: AgentPhoneMessageEvent,
  signal: AbortSignal,
): Promise<void> {
  await sendAgentPhoneText(
    event,
    AGENTPHONE_GROUP_ACCOUNT_COMMAND_MESSAGE,
    signal,
  );
}

async function blockUnauthorizedGroupAccountCommand(args: {
  readonly db: Db;
  readonly event: AgentPhoneMessageEvent;
  readonly commandText: string | undefined;
  readonly userLink: AgentPhoneUserLink | null;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  if (!isAgentPhoneGroupAccountCommand(args.event, args.commandText)) {
    return false;
  }

  const directUserLink = await resolveAgentPhoneUserLink(
    args.db,
    args.event.fromNumber,
    args.event.channel,
  );
  args.signal.throwIfAborted();

  if (directUserLink && directUserLink.id === args.userLink?.id) {
    return false;
  }

  await sendGroupAccountCommandBlockedMessage(args.event, args.signal);
  return true;
}

async function handleConnectCommand(args: {
  readonly event: AgentPhoneMessageEvent;
  readonly userLink: AgentPhoneUserLink | null;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (args.userLink) {
    await sendAgentPhoneSlashCommandText(
      args.event,
      "You are already connected. Send a message here to start chatting with Zero.",
      args.signal,
    );
    return;
  }
  await sendConnectPrompt(args.event, { slashCommand: true }, args.signal);
}

async function handleDisconnectCommand(args: {
  readonly db: Db;
  readonly event: AgentPhoneMessageEvent;
  readonly userLink: AgentPhoneUserLink | null;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (!args.userLink) {
    await sendAgentPhoneSlashCommandText(
      args.event,
      "Error: This phone number is not connected.",
      args.signal,
    );
    return;
  }

  await args.db
    .delete(agentphoneUserLinks)
    .where(eq(agentphoneUserLinks.id, args.userLink.id));
  args.signal.throwIfAborted();

  await sendAgentPhoneSlashCommandText(
    args.event,
    "This phone number has been disconnected from VM0.",
    args.signal,
  );
}

async function handleNewSessionCommand(args: {
  readonly db: Db;
  readonly event: AgentPhoneMessageEvent;
  readonly userLink: AgentPhoneUserLink | null;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (!args.userLink) {
    await sendConnectPrompt(args.event, { slashCommand: true }, args.signal);
    return;
  }

  await args.db
    .delete(agentphoneThreadSessions)
    .where(
      and(
        eq(agentphoneThreadSessions.agentphoneUserLinkId, args.userLink.id),
        eq(
          agentphoneThreadSessions.rootMessageId,
          agentPhoneThreadRootMessageId(args.event),
        ),
      ),
    );
  args.signal.throwIfAborted();

  await sendAgentPhoneSlashCommandText(
    args.event,
    "New session started.",
    args.signal,
  );
}

function commandArgument(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  const firstWhitespaceIndex = trimmed.search(/\s/u);
  if (firstWhitespaceIndex === -1) {
    return "";
  }
  return trimmed.slice(firstWhitespaceIndex).trim();
}

function lookupKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/gu, "-");
}

function compactLookupKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "");
}

function findModelOption(
  options: readonly {
    readonly model: SupportedRunModel;
    readonly label: string;
    readonly isDefault: boolean;
  }[],
  input: string,
) {
  const normalizedInput = normalizeRunModelId(input.trim());
  const inputKeys = new Set([
    lookupKey(input),
    lookupKey(normalizedInput),
    compactLookupKey(input),
    compactLookupKey(normalizedInput),
  ]);
  return options.find((option) => {
    return [
      option.model,
      normalizeRunModelId(option.model),
      option.label,
      getCanonicalModelDisplayName(option.model),
    ].some((value) => {
      return (
        inputKeys.has(lookupKey(value)) ||
        inputKeys.has(compactLookupKey(value))
      );
    });
  });
}

function formatAgentPhoneModelOptionsMessage(
  options: readonly {
    readonly model: SupportedRunModel;
    readonly label: string;
    readonly isDefault: boolean;
  }[],
  currentSelectedModel: string | null,
): string {
  const optionLines = options.map((option) => {
    const markers = [
      option.model === currentSelectedModel ? "current" : null,
      option.isDefault ? "workspace default" : null,
    ].filter((marker): marker is string => {
      return marker !== null;
    });
    const suffix = markers.length > 0 ? ` (${markers.join(", ")})` : "";
    return `/model ${option.model} - ${option.label}${suffix}`;
  });

  const current = currentSelectedModel
    ? getCanonicalModelDisplayName(currentSelectedModel)
    : "workspace default";
  return [
    "Available models",
    "",
    `Current: ${current}`,
    "",
    "Send one of these commands to switch:",
    ...optionLines,
  ].join("\n");
}

const handleModelCommand$ = command(
  async (
    { get, set },
    args: {
      readonly event: AgentPhoneMessageEvent;
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const visibleModels = new Set(getVm0VisibleModels());
    const [policies, preference] = await Promise.all([
      set(
        listOrgModelPolicies$,
        { orgId: args.orgId, userId: args.userId },
        signal,
      ),
      get(userModelPreference({ orgId: args.orgId, userId: args.userId })),
    ]);
    signal.throwIfAborted();

    const options = policies.policies.flatMap((policy) => {
      if (
        !isSupportedRunModel(policy.model) ||
        !visibleModels.has(policy.model) ||
        policy.routeStatus !== "valid"
      ) {
        return [];
      }
      return {
        model: policy.model,
        label: policy.modelLabel,
        isDefault: policy.isDefault,
      };
    });

    if (options.length === 0) {
      await sendAgentPhoneSlashCommandText(
        args.event,
        "Error: No models are configured for this workspace.",
        signal,
      );
      return;
    }

    const input = commandArgument(args.event.body);
    if (!input) {
      await sendAgentPhoneSlashCommandText(
        args.event,
        formatAgentPhoneModelOptionsMessage(options, preference.selectedModel),
        signal,
      );
      return;
    }

    const option = findModelOption(options, input);
    if (!option) {
      await sendAgentPhoneSlashCommandText(
        args.event,
        [
          `Error: Unknown model "${input}".`,
          "",
          formatAgentPhoneModelOptionsMessage(
            options,
            preference.selectedModel,
          ),
        ].join("\n"),
        signal,
      );
      return;
    }

    await set(
      updateUserModelPreference$,
      {
        orgId: args.orgId,
        userId: args.userId,
        preference: { selectedModel: option.model },
      },
      signal,
    );
    signal.throwIfAborted();

    await sendAgentPhoneSlashCommandText(
      args.event,
      `Switched to ${option.label}.`,
      signal,
    );
  },
);

const dispatchAgentPhoneCommand$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly command: string | undefined;
      readonly event: AgentPhoneMessageEvent;
      readonly userLink: AgentPhoneUserLink | null;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    switch (args.command) {
      case "connect": {
        await handleConnectCommand({
          event: args.event,
          userLink: args.userLink,
          signal,
        });
        return true;
      }
      case "disconnect": {
        await handleDisconnectCommand({
          db: args.db,
          event: args.event,
          userLink: args.userLink,
          signal,
        });
        return true;
      }
      case "new_session": {
        await handleNewSessionCommand({
          db: args.db,
          event: args.event,
          userLink: args.userLink,
          signal,
        });
        return true;
      }
      case "help": {
        await sendAgentPhoneSlashCommandText(
          args.event,
          formatHelpMessage(),
          signal,
        );
        return true;
      }
      case "model": {
        if (!args.userLink) {
          await sendConnectPrompt(args.event, { slashCommand: true }, signal);
          return true;
        }
        await set(
          handleModelCommand$,
          {
            event: args.event,
            orgId: args.userLink.orgId,
            userId: args.userLink.vm0UserId,
          },
          signal,
        );
        return true;
      }
      default: {
        return false;
      }
    }
  },
);

const handleAgentPhoneCommandIfPresent$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly event: AgentPhoneMessageEvent;
      readonly userLink: AgentPhoneUserLink | null;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const commandText = parseAgentPhoneCommand(args.event.body);
    if (commandText === undefined) {
      return false;
    }

    if (
      await blockUnauthorizedGroupAccountCommand({
        db: args.db,
        event: args.event,
        commandText,
        userLink: args.userLink,
        signal,
      })
    ) {
      return true;
    }

    return set(
      dispatchAgentPhoneCommand$,
      {
        db: args.db,
        command: commandText,
        event: args.event,
        userLink: args.userLink,
      },
      signal,
    );
  },
);

const runAgentForAgentPhone$ = command(
  async (
    { set },
    args: {
      readonly auth: {
        readonly tokenType: "session";
        readonly userId: string;
        readonly orgId: string;
        readonly orgRole: "member";
      };
      readonly agent: WorkspaceAgent;
      readonly sessionId: string | undefined;
      readonly prompt: string;
      readonly threadContext: string;
      readonly userInfoExtras: { readonly agentphoneHandle: string };
      readonly event: AgentPhoneMessageEvent;
      readonly callbackContext: AgentPhoneCallbackContext;
      readonly apiStartTime: number;
      readonly modelRoute: ModelRoutePin | undefined;
    },
    signal: AbortSignal,
  ): Promise<RunAgentResult> => {
    const result = await set(
      createZeroRun$,
      {
        auth: args.auth,
        body: {
          prompt: args.prompt,
          agentId: args.agent.agentId,
          sessionId: args.sessionId,
          ...(args.modelRoute?.modelProviderType
            ? { modelProvider: args.modelRoute.modelProviderType }
            : {}),
        },
        apiStartTime: args.apiStartTime,
        triggerSource: "agentphone",
        appendSystemPrompt: buildAgentPhonePrompt(
          {
            sharedNumber: optionalEnv("AGENTPHONE_PHONE_NUMBER") ?? "",
            phoneHandle: args.event.fromNumber,
            conversationId: args.event.conversationId,
            channel: args.event.channel,
            isGroup: isAgentPhoneGroupEvent(args.event),
            messageId: args.event.messageId,
            agentphoneAgentId: args.event.agentphoneAgentId,
          },
          args.threadContext,
        ),
        userInfoExtras: args.userInfoExtras,
        modelProviderId: args.modelRoute?.modelProviderId ?? undefined,
        modelProviderCredentialScope:
          args.modelRoute?.modelProviderCredentialScope,
        selectedModelOverride: args.modelRoute?.selectedModel,
        callbacks: [
          {
            url: `${internalApiBaseUrl()}/api/internal/callbacks/agentphone`,
            secret: randomBytes(32).toString("hex"),
            payload: args.callbackContext,
          },
        ],
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.status === 201) {
      return {
        status: result.body.status === "queued" ? "queued" : "accepted",
        runId: result.body.runId,
      };
    }

    return {
      status: "failed",
      response: await set(
        formatIntegrationRunError$,
        {
          orgId: args.auth.orgId,
          userId: args.auth.userId,
          code: result.body.error.code,
          message: result.body.error.message,
        },
        signal,
      ),
    };
  },
);

function resolveAgentPhoneRunFailureAuditLogsUrl(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string | undefined;
}): Computed<Promise<string | undefined>> {
  return computed(async (get): Promise<string | undefined> => {
    if (!args.runId) {
      return undefined;
    }
    const overrides = await get(
      userFeatureSwitchOverrides(args.orgId, args.userId),
    );
    const enabled = isFeatureEnabled(FeatureSwitchKey.AuditLink, {
      userId: args.userId,
      orgId: args.orgId,
      overrides,
    });
    if (!enabled) {
      return undefined;
    }
    return `${env("APP_URL")}/activities/${encodeURIComponent(args.runId)}`;
  });
}

export function formatAgentPhoneAuditLink(logsUrl: string): string {
  return `Audit: ${logsUrl}`;
}

const sendAgentPhoneFailedRunResult$ = command(
  async (
    { get },
    args: {
      readonly event: AgentPhoneMessageEvent;
      readonly userLink: AgentPhoneUserLink;
      readonly result: RunAgentResult;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const logsUrl = await get(
      resolveAgentPhoneRunFailureAuditLogsUrl({
        orgId: args.userLink.orgId,
        userId: args.userLink.vm0UserId,
        runId: args.result.runId,
      }),
    );
    signal.throwIfAborted();
    await sendAgentPhoneText(
      args.event,
      [
        args.result.response ??
          "An unexpected error occurred. Please try again later.",
        logsUrl ? formatAgentPhoneAuditLink(logsUrl) : null,
      ]
        .filter((part): part is string => {
          return Boolean(part);
        })
        .join("\n\n"),
      signal,
    );
  },
);

const handleAgentPhoneRunResult$ = command(
  async (
    { set },
    args: {
      readonly event: AgentPhoneMessageEvent;
      readonly userLink: AgentPhoneUserLink;
      readonly result: RunAgentResult;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    if (args.result.status === "queued") {
      await sendAgentPhoneText(
        args.event,
        "Run queued because the concurrency limit was reached. It will start automatically when a slot is available.",
        signal,
      );
      return;
    }

    if (args.result.status === "failed") {
      await set(
        sendAgentPhoneFailedRunResult$,
        {
          event: args.event,
          userLink: args.userLink,
          result: args.result,
        },
        signal,
      );
    }
  },
);

export const handleAgentPhoneMessage$ = command(
  async (
    { set },
    params: {
      readonly event: AgentPhoneMessageEvent;
      readonly userLink: AgentPhoneUserLink | null;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    if (shouldIgnoreAgentPhoneGroupMessage(params.event)) {
      return;
    }

    if (
      await set(
        handleAgentPhoneCommandIfPresent$,
        {
          db,
          event: params.event,
          userLink: params.userLink,
        },
        signal,
      )
    ) {
      return;
    }

    if (!params.userLink) {
      if (isAgentPhoneGroupEvent(params.event)) {
        await sendGroupConnectInDmPrompt(params.event, signal);
        return;
      }

      await sendConnectPrompt(params.event, undefined, signal);
      return;
    }

    const agent = await resolveAgentPhoneAgent(db, params.userLink);
    signal.throwIfAborted();
    if (!agent) {
      await sendAgentPhoneText(
        params.event,
        "The workspace default agent is not configured. Please choose an agent in VM0 first.",
        signal,
      );
      return;
    }

    await refreshTypingIfSupported(params.event, signal);
    signal.throwIfAborted();

    const modelRoute = await set(
      resolveIntegrationModelRouteForUser$,
      {
        orgId: params.userLink.orgId,
        userId: params.userLink.vm0UserId,
      },
      signal,
    );
    signal.throwIfAborted();

    const rootMessageId = agentPhoneThreadRootMessageId(params.event);
    const session = await resolveCompatibleAgentPhoneThreadSession({
      db,
      userLinkId: params.userLink.id,
      userId: params.userLink.vm0UserId,
      agentComposeId: agent.composeId,
      rootMessageId,
      modelRoute,
    });
    signal.throwIfAborted();

    const isGroup = isAgentPhoneGroupEvent(params.event);
    const { executionContext } = await fetchAgentPhoneContext(db, {
      userLinkId: params.userLink.id,
      phoneHandle: params.event.fromNumber,
      channel: params.event.channel,
      conversationId: params.event.conversationId,
      isGroup,
      recentHistory: params.event.recentHistory,
      currentMessageId: params.event.messageId,
    });
    signal.throwIfAborted();

    const { prompt, userInfoExtras } = enrichAgentPhonePrompt({
      prompt: params.event.body,
      phoneHandle: params.event.fromNumber,
      channel: params.event.channel,
      messageId: params.event.messageId,
      mediaUrl: params.event.mediaUrl,
      isGroup,
    });

    const result = await set(
      runAgentForAgentPhone$,
      {
        auth: {
          tokenType: "session",
          userId: params.userLink.vm0UserId,
          orgId: params.userLink.orgId,
          orgRole: "member",
        },
        agent,
        sessionId: session.existingSessionId,
        prompt,
        threadContext: executionContext,
        userInfoExtras,
        event: params.event,
        apiStartTime: params.apiStartTime,
        modelRoute,
        callbackContext: {
          messageId: params.event.messageId,
          conversationId: params.event.conversationId,
          channel: params.event.channel,
          isGroup,
          rootMessageId,
          phoneHandle: params.event.fromNumber,
          fromNumber: params.event.fromNumber,
          toNumber: params.event.toNumber,
          userLinkId: params.userLink.id,
          agentId: agent.composeId,
          agentphoneAgentId: params.event.agentphoneAgentId,
          existingSessionId: session.existingSessionId ?? null,
        },
      },
      signal,
    );

    await set(
      handleAgentPhoneRunResult$,
      {
        event: params.event,
        userLink: params.userLink,
        result,
      },
      signal,
    );
  },
);

export function markdownToImessagePlain(markdown: string): string {
  if (markdown.length === 0) {
    return markdown;
  }

  let text = markdown;
  text = text.replace(
    /```[^\n]*\n?([\s\S]*?)\n?```/g,
    (_match, content: string) => {
      return content;
    },
  );
  text = text.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (_match, alt: string, url: string) => {
      const label = alt.trim();
      return label ? `${label}\n${url}` : url;
    },
  );
  text = text.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (_match, label: string, url: string) => {
      const trimmed = label.trim();
      if (!trimmed || trimmed === url) {
        return url;
      }
      return `${trimmed}\n${url}`;
    },
  );
  text = text.replace(/\*\*([^\n*]+)\*\*/g, "$1");
  text = text.replace(/__([^\n_]+)__/g, "$1");
  text = text.replace(/\*([^\n*]+)\*/g, "$1");
  text = text.replace(/(^|[^A-Za-z0-9_])_([^\n_]+)_(?![A-Za-z0-9_])/g, "$1$2");
  text = text.replace(/`([^`\n]+)`/g, "$1");
  text = text.replace(/~~([^\n~]+)~~/g, "$1");
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");
  text = text.replace(/^(.+)\n[=-]{2,}[ \t]*$/gm, "$1");
  text = text.replace(/^([ \t]*)[-*+][ \t]+/gm, "$1- ");
  text = text.replace(/^[ \t]*>[ \t]?/gm, "");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function plainLabel(value: string | null | undefined): string | undefined {
  const label = value?.trim().replace(/\s+/gu, " ");
  return label || undefined;
}

function displayLabel(row: {
  readonly agentDisplayName: string | null;
  readonly agentName: string | null;
  readonly composeName: string;
}): string {
  return (
    plainLabel(row.agentDisplayName) ??
    plainLabel(row.agentName) ??
    plainLabel(row.composeName) ??
    "zero"
  );
}

async function resolveComposeLabel(
  db: ReadonlyDb,
  composeId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({
      agentDisplayName: zeroAgents.displayName,
      agentName: zeroAgents.name,
      composeName: agentComposes.name,
    })
    .from(agentComposes)
    .leftJoin(zeroAgents, eq(zeroAgents.id, agentComposes.id))
    .where(eq(agentComposes.id, composeId))
    .limit(1);
  return row ? displayLabel(row) : undefined;
}

export async function resolveAgentPhoneReplyFooterText(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly composeId: string;
}): Promise<string | undefined> {
  const orgDefaultComposeId = await resolveOrgDefaultComposeId(
    args.db,
    args.orgId,
  );
  if (!orgDefaultComposeId || args.composeId === orgDefaultComposeId) {
    return undefined;
  }

  const label = await resolveComposeLabel(args.db, args.composeId);
  return label ? `Responded by ${label}` : undefined;
}

export async function resolveAgentPhoneAuditLogsUrl(args: {
  readonly getFeatureOverrides: (
    orgId: string,
    userId: string,
  ) => Promise<Record<string, boolean>>;
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
  readonly signal: AbortSignal;
}): Promise<string | undefined> {
  const overrides = await args.getFeatureOverrides(args.orgId, args.userId);
  args.signal.throwIfAborted();
  const enabled = isFeatureEnabled(FeatureSwitchKey.AuditLink, {
    userId: args.userId,
    orgId: args.orgId,
    overrides,
  });
  if (!enabled) {
    return undefined;
  }
  return `${env("APP_URL")}/activities/${encodeURIComponent(args.runId)}`;
}

export async function publishAgentPhoneUserChanged(
  userId: string,
): Promise<void> {
  const result = await settle(
    publishUserSignal([userId], "agentphone:changed"),
  );
  if (!result.ok) {
    log.warn("Failed to publish AgentPhone user signal", {
      userId,
      error: result.error,
    });
  }
}
