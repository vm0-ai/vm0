import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { agentphoneMessages } from "@vm0/db/schema/agentphone-message";
import { agentphoneThreadSessions } from "@vm0/db/schema/agentphone-thread-session";
import { agentphoneUserLinks } from "@vm0/db/schema/agentphone-user-link";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { and, eq } from "drizzle-orm";

import { env } from "../../lib/env";
import { nowDate } from "../external/time";
import type { Db, ReadonlyDb } from "../external/db";

export type AgentPhoneChannel = "imessage" | "sms" | "mms";
export type AgentPhoneUserLink = typeof agentphoneUserLinks.$inferSelect;

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

export async function touchAgentPhoneUserLink(
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

export function formatAgentPhoneAuditLink(logsUrl: string): string {
  return `Audit: ${logsUrl}`;
}

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

export async function resolveOrgDefaultComposeId(
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
  const enabled = isFeatureEnabled(FeatureSwitchKey.ZeroDebug, {
    userId: args.userId,
    orgId: args.orgId,
    overrides,
  });
  if (!enabled) {
    return undefined;
  }
  return `${env("APP_URL")}/activities/${encodeURIComponent(args.runId)}`;
}
