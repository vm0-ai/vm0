import { and, desc, eq } from "drizzle-orm";
import { imessageMessages } from "@vm0/db/schema/imessage-message";
import { imessageThreadSessions } from "@vm0/db/schema/imessage-thread-session";
import { imessageUserAgentPreferences } from "@vm0/db/schema/imessage-user-agent-preference";
import { imessageUserLinks } from "@vm0/db/schema/imessage-user-link";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { ensureStorageExists } from "../../infra/storage/storage-service";
import { getAppUrl } from "../url";
import { resolveDefaultAgentId } from "../resolve-default-agent";
import { signIMessageConnectParams } from "./connect-token";
import { IMESSAGE_ROOT_MESSAGE_ID } from "./constants";
import type { UserInfoOptions } from "../integration-prompt";

export type IMessageUserLink = typeof imessageUserLinks.$inferSelect;

type LinkIMessageUserResult =
  | { ok: true; userLink: IMessageUserLink }
  | {
      ok: false;
      reason: "phone-handle-linked" | "vm0-org-linked" | "conflict";
      userLink?: IMessageUserLink;
    };

interface ThreadSessionLookup {
  existingSessionId: string | undefined;
  lastProcessedMessageId: string | undefined;
}

export interface AgentPhoneIMessageEvent {
  webhookId: string | null;
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

async function touchIMessageUserLink(
  userLink: IMessageUserLink,
  phoneHandle: string,
): Promise<IMessageUserLink> {
  const normalized = normalizePhoneHandle(phoneHandle);
  if (userLink.phoneHandle === normalized) return userLink;

  const [updated] = await globalThis.services.db
    .update(imessageUserLinks)
    .set({ phoneHandle: normalized, updatedAt: new Date() })
    .where(eq(imessageUserLinks.id, userLink.id))
    .returning();

  return updated ?? userLink;
}

export async function linkIMessageUserToVm0User(params: {
  phoneHandle: string;
  vm0UserId: string;
  orgId: string;
}): Promise<LinkIMessageUserResult> {
  const phoneHandle = normalizePhoneHandle(params.phoneHandle);
  const [existingPhoneLink] = await globalThis.services.db
    .select()
    .from(imessageUserLinks)
    .where(eq(imessageUserLinks.phoneHandle, phoneHandle))
    .limit(1);

  if (existingPhoneLink) {
    if (
      existingPhoneLink.vm0UserId === params.vm0UserId &&
      existingPhoneLink.orgId === params.orgId
    ) {
      return {
        ok: true,
        userLink: await touchIMessageUserLink(existingPhoneLink, phoneHandle),
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
    .from(imessageUserLinks)
    .where(
      and(
        eq(imessageUserLinks.vm0UserId, params.vm0UserId),
        eq(imessageUserLinks.orgId, params.orgId),
      ),
    )
    .limit(1);

  if (existingVm0OrgLink) {
    if (existingVm0OrgLink.phoneHandle === phoneHandle) {
      return {
        ok: true,
        userLink: await touchIMessageUserLink(existingVm0OrgLink, phoneHandle),
      };
    }

    return {
      ok: false,
      reason: "vm0-org-linked",
      userLink: existingVm0OrgLink,
    };
  }

  const [inserted] = await globalThis.services.db
    .insert(imessageUserLinks)
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

export async function resolveIMessageUserLink(
  phoneHandle: string,
): Promise<IMessageUserLink | null> {
  const normalized = normalizePhoneHandle(phoneHandle);
  const [userLink] = await globalThis.services.db
    .select()
    .from(imessageUserLinks)
    .where(eq(imessageUserLinks.phoneHandle, normalized))
    .limit(1);

  if (!userLink) return null;
  return touchIMessageUserLink(userLink, normalized);
}

export async function ensureIMessageOrgAndArtifact(
  vm0UserId: string,
  orgId: string,
): Promise<void> {
  await ensureStorageExists(orgId, vm0UserId, "artifact", "artifact");
}

export function buildIMessageConnectUrl(params: {
  phoneHandle: string;
  agentphoneAgentId: string;
  secret: string;
}): string {
  const ts = Math.floor(Date.now() / 1000);
  const phoneHandle = normalizePhoneHandle(params.phoneHandle);
  const sig = signIMessageConnectParams(
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
  return `${getAppUrl()}/api/agentphone/imessage/connect?${query.toString()}`;
}

async function getIMessageUserAgentPreference(
  vm0UserId: string,
  orgId: string,
): Promise<string | null> {
  const [row] = await globalThis.services.db
    .select({
      selectedComposeId: imessageUserAgentPreferences.selectedComposeId,
    })
    .from(imessageUserAgentPreferences)
    .where(
      and(
        eq(imessageUserAgentPreferences.vm0UserId, vm0UserId),
        eq(imessageUserAgentPreferences.orgId, orgId),
      ),
    )
    .limit(1);

  return row?.selectedComposeId ?? null;
}

export async function resolveEffectiveIMessageComposeId(
  vm0UserId: string,
  orgId: string,
): Promise<string | null> {
  const preference = await getIMessageUserAgentPreference(vm0UserId, orgId);
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

export async function lookupIMessageThreadSession(
  userLinkId: string,
): Promise<ThreadSessionLookup> {
  const [session] = await globalThis.services.db
    .select({
      agentSessionId: imessageThreadSessions.agentSessionId,
      lastProcessedMessageId: imessageThreadSessions.lastProcessedMessageId,
    })
    .from(imessageThreadSessions)
    .where(
      and(
        eq(imessageThreadSessions.imessageUserLinkId, userLinkId),
        eq(imessageThreadSessions.rootMessageId, IMESSAGE_ROOT_MESSAGE_ID),
      ),
    )
    .limit(1);

  return {
    existingSessionId: session?.agentSessionId,
    lastProcessedMessageId: session?.lastProcessedMessageId ?? undefined,
  };
}

export async function saveIMessageThreadSession(opts: {
  userLinkId: string;
  conversationId: string | null;
  existingSessionId: string | undefined;
  newSessionId: string | undefined;
  messageId: string;
  runStatus: string;
}): Promise<void> {
  if (!opts.existingSessionId && opts.newSessionId) {
    await globalThis.services.db
      .insert(imessageThreadSessions)
      .values({
        imessageUserLinkId: opts.userLinkId,
        conversationId: opts.conversationId,
        rootMessageId: IMESSAGE_ROOT_MESSAGE_ID,
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
      .update(imessageThreadSessions)
      .set({
        conversationId: opts.conversationId,
        lastProcessedMessageId: opts.messageId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(imessageThreadSessions.imessageUserLinkId, opts.userLinkId),
          eq(imessageThreadSessions.rootMessageId, IMESSAGE_ROOT_MESSAGE_ID),
        ),
      );
  }
}

export async function storeInboundIMessageMessage(params: {
  event: AgentPhoneIMessageEvent;
  userLinkId?: string | null;
}): Promise<{ inserted: boolean }> {
  const inserted = await globalThis.services.db
    .insert(imessageMessages)
    .values({
      webhookId: params.event.webhookId,
      agentphoneMessageId: params.event.messageId,
      conversationId: params.event.conversationId,
      agentphoneAgentId: params.event.agentphoneAgentId,
      imessageUserLinkId: params.userLinkId ?? null,
      phoneHandle: normalizePhoneHandle(params.event.fromNumber),
      fromNumber: normalizePhoneHandle(params.event.fromNumber),
      toNumber: normalizePhoneHandle(params.event.toNumber),
      direction: "inbound",
      channel: "imessage",
      body: params.event.body || null,
      mediaUrl: params.event.mediaUrl,
      isBot: false,
      receivedAt: params.event.receivedAt,
    })
    .onConflictDoNothing()
    .returning({ id: imessageMessages.id });

  return { inserted: inserted.length > 0 };
}

export async function storeOutboundIMessageMessage(params: {
  agentphoneMessageId: string;
  conversationId: string | null;
  agentphoneAgentId: string;
  userLinkId: string;
  phoneHandle: string;
  fromNumber: string;
  toNumber: string;
  body: string | undefined;
  channel: string | null;
}): Promise<void> {
  await globalThis.services.db
    .insert(imessageMessages)
    .values({
      agentphoneMessageId: params.agentphoneMessageId,
      conversationId: params.conversationId,
      agentphoneAgentId: params.agentphoneAgentId,
      imessageUserLinkId: params.userLinkId,
      phoneHandle: normalizePhoneHandle(params.phoneHandle),
      fromNumber: normalizePhoneHandle(params.fromNumber),
      toNumber: normalizePhoneHandle(params.toNumber),
      direction: "outbound",
      channel: params.channel ?? "imessage",
      body: params.body ?? null,
      isBot: true,
    })
    .onConflictDoNothing();
}

export async function fetchIMessageContext(params: {
  phoneHandle: string;
  lastProcessedMessageId?: string;
  currentMessageId?: string;
}): Promise<{ executionContext: string }> {
  const phoneHandle = normalizePhoneHandle(params.phoneHandle);
  const messages = await globalThis.services.db
    .select({
      messageId: imessageMessages.agentphoneMessageId,
      body: imessageMessages.body,
      mediaUrl: imessageMessages.mediaUrl,
      isBot: imessageMessages.isBot,
      direction: imessageMessages.direction,
    })
    .from(imessageMessages)
    .where(eq(imessageMessages.phoneHandle, phoneHandle))
    .orderBy(desc(imessageMessages.createdAt))
    .limit(10);

  const chronological = messages.reverse().filter((message) => {
    return (
      !params.currentMessageId || message.messageId !== params.currentMessageId
    );
  });

  const lastProcessedIndex = params.lastProcessedMessageId
    ? chronological.findIndex((message) => {
        return message.messageId === params.lastProcessedMessageId;
      })
    : -1;
  const executionMessages =
    lastProcessedIndex >= 0
      ? chronological.slice(lastProcessedIndex + 1)
      : chronological;

  if (executionMessages.length === 0) {
    return { executionContext: "" };
  }

  const total = executionMessages.length;
  const formatted = executionMessages.map((message, index) => {
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
      parts.push("", `[iMessage media] ${message.mediaUrl}`);
    }
    return parts.join("\n");
  });

  return {
    executionContext: [
      "# iMessage Context",
      "",
      "The messages below are from the user's iMessage conversation with the shared Zero number. Messages closer to RELATIVE_INDEX 0 are more recent.",
      "",
      formatted.join("\n\n"),
      "",
      "---",
    ].join("\n"),
  };
}

export function enrichIMessagePrompt(
  prompt: string,
  phoneHandle: string,
  mediaUrl: string | null,
): { prompt: string; userInfoExtras: UserInfoOptions } {
  const normalized = normalizePhoneHandle(phoneHandle);
  const parts = [prompt.trim()];
  if (mediaUrl) {
    parts.push(`[iMessage media] ${mediaUrl}`);
  }
  return {
    prompt: parts.filter(Boolean).join("\n\n"),
    userInfoExtras: { imessageHandle: normalized },
  };
}
