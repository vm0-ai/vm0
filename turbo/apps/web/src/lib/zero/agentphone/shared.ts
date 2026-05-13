import { and, desc, eq } from "drizzle-orm";
import { agentphoneMessages } from "@vm0/db/schema/agentphone-message";
import { agentphoneThreadSessions } from "@vm0/db/schema/agentphone-thread-session";
import { agentphoneUserAgentPreferences } from "@vm0/db/schema/agentphone-user-agent-preference";
import { agentphoneUserLinks } from "@vm0/db/schema/agentphone-user-link";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { ensureStorageExists } from "../../infra/storage/storage-service";
import { getAppUrl } from "../url";
import { resolveDefaultAgentId } from "../resolve-default-agent";
import { signAgentPhoneConnectParams } from "./connect-token";
import { AGENTPHONE_ROOT_MESSAGE_ID } from "./constants";
import { formatAgentPhoneFileForContext } from "./media";
import type { UserInfoOptions } from "../integration-prompt";

export type AgentPhoneUserLink = typeof agentphoneUserLinks.$inferSelect;

type LinkAgentPhoneUserResult =
  | { ok: true; userLink: AgentPhoneUserLink }
  | {
      ok: false;
      reason: "phone-handle-linked" | "vm0-org-linked" | "conflict";
      userLink?: AgentPhoneUserLink;
    };

interface ThreadSessionLookup {
  existingSessionId: string | undefined;
  lastProcessedMessageId: string | undefined;
}

export interface AgentPhoneMessageEvent {
  webhookId: string | null;
  channel: string;
  messageId: string;
  conversationId: string | null;
  agentphoneAgentId: string;
  fromNumber: string;
  toNumber: string;
  body: string;
  mediaUrl: string | null;
  receivedAt: Date | null;
}

export function normalizePhoneHandle(handle: string): string {
  return handle.trim().replace(/[^\d+]/gu, "");
}

async function touchAgentPhoneUserLink(
  userLink: AgentPhoneUserLink,
  phoneHandle: string,
): Promise<AgentPhoneUserLink> {
  const normalized = normalizePhoneHandle(phoneHandle);
  if (userLink.phoneHandle === normalized) return userLink;

  const [updated] = await globalThis.services.db
    .update(agentphoneUserLinks)
    .set({ phoneHandle: normalized, updatedAt: new Date() })
    .where(eq(agentphoneUserLinks.id, userLink.id))
    .returning();

  return updated ?? userLink;
}

export async function linkAgentPhoneUserToVm0User(params: {
  phoneHandle: string;
  vm0UserId: string;
  orgId: string;
}): Promise<LinkAgentPhoneUserResult> {
  const phoneHandle = normalizePhoneHandle(params.phoneHandle);
  const [existingPhoneLink] = await globalThis.services.db
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
        userLink: await touchAgentPhoneUserLink(existingPhoneLink, phoneHandle),
      };
    }

    return {
      ok: false,
      reason: "phone-handle-linked",
      userLink: existingPhoneLink,
    };
  }

  const [existingVm0OrgLink] = await globalThis.services.db
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
          existingVm0OrgLink,
          phoneHandle,
        ),
      };
    }

    return {
      ok: false,
      reason: "vm0-org-linked",
      userLink: existingVm0OrgLink,
    };
  }

  const [inserted] = await globalThis.services.db
    .insert(agentphoneUserLinks)
    .values({
      phoneHandle,
      vm0UserId: params.vm0UserId,
      orgId: params.orgId,
    })
    .onConflictDoNothing()
    .returning();

  if (inserted) return { ok: true, userLink: inserted };
  return { ok: false, reason: "conflict" };
}

export async function resolveAgentPhoneUserLink(
  phoneHandle: string,
): Promise<AgentPhoneUserLink | null> {
  const normalized = normalizePhoneHandle(phoneHandle);
  const [userLink] = await globalThis.services.db
    .select()
    .from(agentphoneUserLinks)
    .where(eq(agentphoneUserLinks.phoneHandle, normalized))
    .limit(1);

  if (!userLink) return null;
  return touchAgentPhoneUserLink(userLink, normalized);
}

export async function resolveAgentPhoneUserLinkForOwner(params: {
  phoneHandle: string;
  vm0UserId: string;
  orgId: string;
}): Promise<AgentPhoneUserLink | null> {
  const normalized = normalizePhoneHandle(params.phoneHandle);
  const [userLink] = await globalThis.services.db
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

  if (!userLink) return null;
  return touchAgentPhoneUserLink(userLink, normalized);
}

export async function resolveAgentPhoneAgentIdForUserLink(params: {
  userLinkId: string;
  phoneHandle: string;
  agentphoneAgentId?: string | null;
}): Promise<string | null> {
  if (params.agentphoneAgentId) return params.agentphoneAgentId;

  const [message] = await globalThis.services.db
    .select({ agentphoneAgentId: agentphoneMessages.agentphoneAgentId })
    .from(agentphoneMessages)
    .where(
      and(
        eq(agentphoneMessages.agentphoneUserLinkId, params.userLinkId),
        eq(
          agentphoneMessages.phoneHandle,
          normalizePhoneHandle(params.phoneHandle),
        ),
      ),
    )
    .orderBy(desc(agentphoneMessages.createdAt))
    .limit(1);

  return message?.agentphoneAgentId ?? null;
}

export async function ensureAgentPhoneOrgAndArtifact(
  vm0UserId: string,
  orgId: string,
): Promise<void> {
  await ensureStorageExists(orgId, vm0UserId, "artifact", "artifact");
}

export function buildAgentPhoneConnectUrl(params: {
  phoneHandle: string;
  agentphoneAgentId: string;
  secret: string;
}): string {
  const ts = Math.floor(Date.now() / 1000);
  const phoneHandle = normalizePhoneHandle(params.phoneHandle);
  const sig = signAgentPhoneConnectParams(
    phoneHandle,
    params.agentphoneAgentId,
    ts,
    params.secret,
  );
  const query = new URLSearchParams({
    handle: phoneHandle,
    agent: params.agentphoneAgentId,
    ts: String(ts),
    sig,
  });
  return `${getAppUrl()}/agentphone/connect?${query.toString()}`;
}

async function getAgentPhoneUserAgentPreference(
  vm0UserId: string,
  orgId: string,
): Promise<string | null> {
  const [row] = await globalThis.services.db
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

export async function resolveEffectiveAgentPhoneComposeId(
  vm0UserId: string,
  orgId: string,
): Promise<string | null> {
  const preference = await getAgentPhoneUserAgentPreference(vm0UserId, orgId);
  if (preference) {
    const [compose] = await globalThis.services.db
      .select({ id: agentComposes.id })
      .from(agentComposes)
      .where(
        and(eq(agentComposes.id, preference), eq(agentComposes.orgId, orgId)),
      )
      .limit(1);

    if (compose?.id) return preference;
  }

  return resolveDefaultAgentId(orgId);
}

export async function lookupAgentPhoneThreadSession(
  userLinkId: string,
): Promise<ThreadSessionLookup> {
  const [session] = await globalThis.services.db
    .select({
      agentSessionId: agentphoneThreadSessions.agentSessionId,
      lastProcessedMessageId: agentphoneThreadSessions.lastProcessedMessageId,
    })
    .from(agentphoneThreadSessions)
    .where(
      and(
        eq(agentphoneThreadSessions.agentphoneUserLinkId, userLinkId),
        eq(agentphoneThreadSessions.rootMessageId, AGENTPHONE_ROOT_MESSAGE_ID),
      ),
    )
    .limit(1);

  return {
    existingSessionId: session?.agentSessionId,
    lastProcessedMessageId: session?.lastProcessedMessageId ?? undefined,
  };
}

export async function saveAgentPhoneThreadSession(opts: {
  userLinkId: string;
  conversationId: string | null;
  existingSessionId: string | undefined;
  newSessionId: string | undefined;
  messageId: string;
  runStatus: string;
}): Promise<void> {
  if (!opts.existingSessionId && opts.newSessionId) {
    const updated = await globalThis.services.db
      .update(agentphoneThreadSessions)
      .set({
        agentSessionId: opts.newSessionId,
        conversationId: opts.conversationId,
        lastProcessedMessageId: opts.messageId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agentphoneThreadSessions.agentphoneUserLinkId, opts.userLinkId),
          eq(
            agentphoneThreadSessions.rootMessageId,
            AGENTPHONE_ROOT_MESSAGE_ID,
          ),
        ),
      )
      .returning({ id: agentphoneThreadSessions.id });

    if (updated.length > 0) return;

    await globalThis.services.db
      .insert(agentphoneThreadSessions)
      .values({
        agentphoneUserLinkId: opts.userLinkId,
        conversationId: opts.conversationId,
        rootMessageId: AGENTPHONE_ROOT_MESSAGE_ID,
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
    await globalThis.services.db
      .update(agentphoneThreadSessions)
      .set({
        conversationId: opts.conversationId,
        lastProcessedMessageId: opts.messageId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agentphoneThreadSessions.agentphoneUserLinkId, opts.userLinkId),
          eq(
            agentphoneThreadSessions.rootMessageId,
            AGENTPHONE_ROOT_MESSAGE_ID,
          ),
        ),
      );
  }
}

export async function storeInboundAgentPhoneMessage(params: {
  event: AgentPhoneMessageEvent;
  userLinkId?: string | null;
}): Promise<{ inserted: boolean }> {
  const inserted = await globalThis.services.db
    .insert(agentphoneMessages)
    .values({
      webhookId: params.event.webhookId,
      agentphoneMessageId: params.event.messageId,
      conversationId: params.event.conversationId,
      agentphoneAgentId: params.event.agentphoneAgentId,
      agentphoneUserLinkId: params.userLinkId ?? null,
      phoneHandle: normalizePhoneHandle(params.event.fromNumber),
      fromNumber: normalizePhoneHandle(params.event.fromNumber),
      toNumber: normalizePhoneHandle(params.event.toNumber),
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

export async function storeOutboundAgentPhoneMessage(params: {
  agentphoneMessageId: string;
  conversationId: string | null;
  agentphoneAgentId: string;
  userLinkId: string;
  phoneHandle: string;
  fromNumber: string;
  toNumber: string;
  body: string | undefined;
  channel: string | null;
  mediaUrl?: string | null;
}): Promise<void> {
  await globalThis.services.db
    .insert(agentphoneMessages)
    .values({
      agentphoneMessageId: params.agentphoneMessageId,
      conversationId: params.conversationId,
      agentphoneAgentId: params.agentphoneAgentId,
      agentphoneUserLinkId: params.userLinkId,
      phoneHandle: normalizePhoneHandle(params.phoneHandle),
      fromNumber: normalizePhoneHandle(params.fromNumber),
      toNumber: normalizePhoneHandle(params.toNumber),
      direction: "outbound",
      channel: params.channel ?? "unknown",
      body: params.body ?? null,
      mediaUrl: params.mediaUrl ?? null,
      isBot: true,
    })
    .onConflictDoNothing();
}

export async function fetchAgentPhoneContext(params: {
  userLinkId: string;
  phoneHandle: string;
  lastProcessedMessageId?: string;
  currentMessageId?: string;
}): Promise<{ executionContext: string }> {
  const phoneHandle = normalizePhoneHandle(params.phoneHandle);
  const messages = await globalThis.services.db
    .select({
      messageId: agentphoneMessages.agentphoneMessageId,
      body: agentphoneMessages.body,
      mediaUrl: agentphoneMessages.mediaUrl,
      isBot: agentphoneMessages.isBot,
      direction: agentphoneMessages.direction,
    })
    .from(agentphoneMessages)
    .where(
      and(
        eq(agentphoneMessages.agentphoneUserLinkId, params.userLinkId),
        eq(agentphoneMessages.phoneHandle, phoneHandle),
      ),
    )
    .orderBy(desc(agentphoneMessages.createdAt))
    .limit(10);

  const chronological = messages.reverse().filter((message) => {
    return (
      !params.currentMessageId || message.messageId !== params.currentMessageId
    );
  });

  if (chronological.length === 0) {
    return { executionContext: "" };
  }

  const total = chronological.length;
  const formatted = chronological.map((message, index) => {
    const sender = message.isBot ? "BOT" : phoneHandle;
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

  return {
    executionContext: [
      "# AgentPhone Message Context",
      "",
      "The messages below are from the user's text message conversation with the shared Zero number. Messages closer to RELATIVE_INDEX 0 are more recent.",
      "",
      formatted.join("\n\n"),
      "",
      "---",
    ].join("\n"),
  };
}

export function enrichAgentPhonePrompt(
  prompt: string,
  phoneHandle: string,
  messageId: string,
  mediaUrl: string | null,
): { prompt: string; userInfoExtras: UserInfoOptions } {
  const normalized = normalizePhoneHandle(phoneHandle);
  const parts = [prompt.trim()];
  if (mediaUrl) {
    parts.push(formatAgentPhoneFileForContext({ messageId, mediaUrl }));
  }
  return {
    prompt: parts.filter(Boolean).join("\n\n"),
    userInfoExtras: { agentphoneHandle: normalized },
  };
}
