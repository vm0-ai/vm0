import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import {
  relationshipMemorySettings,
  relationshipSyncJobs,
  type RelationshipMemoryProvider,
  type RelationshipSyncJobPayload,
} from "@vm0/db/schema/relationship-memory";

import type { Db, ReadonlyDb } from "../external/db";
import { nowDate } from "../external/time";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { recordMemorySource } from "./memory-substrate.service";

export type GmailRelationshipMessageDirection = "received" | "sent";

interface GmailRelationshipMessageBase {
  readonly mailboxEmail: string;
  readonly historyId: string;
  readonly messageId: string;
  readonly threadId: string | null;
  readonly occurredAt: string | null;
  readonly direction: GmailRelationshipMessageDirection | null;
  readonly from: string | null;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject: string | null;
}

export interface GmailRelationshipMessage extends GmailRelationshipMessageBase {
  readonly bodyText: string | null;
}

type PersistedGmailRelationshipMessage = Pick<
  GmailRelationshipMessageBase,
  "historyId" | "messageId" | "threadId"
>;

interface ParsedEmailAddress {
  readonly displayName: string;
  readonly email: string;
  readonly domain: string;
}

export interface RelationshipTarget {
  readonly type: "person" | "organization";
  readonly identityKey: string;
  readonly displayName: string;
  readonly primaryEmail: string | null;
  readonly domain: string | null;
  readonly relationshipType: string;
  readonly fallbackSummary: string;
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase();
}

function parseEmailAddress(value: string | null): ParsedEmailAddress | null {
  if (!value) {
    return null;
  }
  const emailMatch = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const emailValue = emailMatch?.[0];
  if (!emailValue) {
    return null;
  }
  const email = normalizeEmail(emailValue);

  const domain = email.split("@")[1];
  if (!domain) {
    return null;
  }

  return {
    displayName: email,
    email,
    domain: normalizeDomain(domain),
  };
}

function isSystemSender(address: ParsedEmailAddress): boolean {
  const localPart = address.email.split("@")[0] ?? "";
  return /^(no-?reply|do-?not-?reply|notifications?|newsletter|mailer|support|noreply)$/i.test(
    localPart,
  );
}

function displayNameFromDomain(domain: string): string {
  const base = domain.split(".")[0] ?? domain;
  return `${base.slice(0, 1).toUpperCase()}${base.slice(1)}`;
}

export function relationshipTargets(
  message: GmailRelationshipMessageBase,
): readonly RelationshipTarget[] {
  const addresses =
    message.direction === "sent"
      ? [...message.to, ...message.cc]
      : [message.from];
  const targets = new Map<string, RelationshipTarget>();

  for (const value of addresses) {
    const address = parseEmailAddress(value);
    if (!address || isSystemSender(address)) {
      continue;
    }

    if (address.email === normalizeEmail(message.mailboxEmail)) {
      continue;
    }

    const personSummary =
      message.direction === "sent"
        ? `${address.displayName} received recent Gmail messages from the user.`
        : `${address.displayName} has recent Gmail interactions with the user.`;
    const organizationName = displayNameFromDomain(address.domain);

    targets.set(`person:${address.email}`, {
      type: "person",
      identityKey: `person:${address.email}`,
      displayName: address.displayName,
      primaryEmail: address.email,
      domain: address.domain,
      relationshipType: "External contact",
      fallbackSummary: personSummary,
    });
    targets.set(`organization:${address.domain}`, {
      type: "organization",
      identityKey: `organization:${address.domain}`,
      displayName: organizationName,
      primaryEmail: null,
      domain: address.domain,
      relationshipType: "Organization",
      fallbackSummary: `${organizationName} appears in recent Gmail interactions.`,
    });
  }

  if (targets.size === 0) {
    return [];
  }
  return [...targets.values()];
}

export async function relationshipMemoryFeatureEnabled(
  db: ReadonlyDb,
  orgId: string,
  userId: string,
): Promise<boolean> {
  const context = await loadUserFeatureSwitchContext(db, orgId, userId);
  return isFeatureEnabled(FeatureSwitchKey.RelationshipMemory, context);
}

function memorySourceExtractionDedupeKey(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly provider: RelationshipMemoryProvider;
  readonly externalId: string;
}): string {
  return [
    args.orgId,
    args.userId,
    args.provider,
    "memory_source_relationship_extract",
    args.externalId,
  ].join(":");
}

function parsedOccurredAt(value: string | null): Date | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function enqueueGmailRelationshipRefreshJob(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId: string;
    readonly message: GmailRelationshipMessage;
    readonly priority?: number;
    readonly reason?: "gmail_webhook" | "gmail_backfill";
  },
): Promise<boolean> {
  if (
    !args.message.occurredAt ||
    !parseEmailAddress(args.message.mailboxEmail) ||
    !(await relationshipMemoryFeatureEnabled(db, args.orgId, args.userId)) ||
    relationshipTargets(args.message).length === 0
  ) {
    return false;
  }

  const didRecordSource = await recordMemorySource(db, {
    orgId: args.orgId,
    userId: args.userId,
    provider: "gmail",
    sourceType: "gmail_message",
    externalId: args.message.messageId,
    connectorId: args.connectorId,
    occurredAt: parsedOccurredAt(args.message.occurredAt),
    title: args.message.subject,
    metadata: {
      mailboxEmail: args.message.mailboxEmail,
      historyId: args.message.historyId,
      threadId: args.message.threadId,
      messageId: args.message.messageId,
      direction: args.message.direction ?? "unknown",
      from: args.message.from,
      to: args.message.to,
      cc: args.message.cc,
      reason: args.reason ?? "gmail_webhook",
    },
  });

  if (!didRecordSource) {
    return false;
  }

  const gmailMessage: PersistedGmailRelationshipMessage = {
    historyId: args.message.historyId,
    messageId: args.message.messageId,
    threadId: args.message.threadId,
  };

  return await enqueueMemorySourceRelationshipExtractionJob(db, {
    orgId: args.orgId,
    userId: args.userId,
    provider: "gmail",
    sourceExternalId: args.message.messageId,
    connectorId: args.connectorId,
    gmailThreadId: args.message.threadId ?? undefined,
    gmailMessageIds: [args.message.messageId],
    historyId: args.message.historyId,
    gmailMessage,
    reason: args.reason ?? "gmail_webhook",
    priority: args.priority,
    replaceExisting: args.reason !== "gmail_backfill",
  });
}

export async function enqueueMemorySourceRelationshipExtractionJob(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly provider: RelationshipMemoryProvider;
    readonly sourceExternalId: string;
    readonly connectorId?: string | null;
    readonly priority?: number;
    readonly replaceExisting?: boolean;
    readonly gmailMessage?: PersistedGmailRelationshipMessage;
    readonly gmailThreadId?: string;
    readonly gmailMessageIds?: readonly string[];
    readonly historyId?: string;
    readonly reason?: string;
  },
): Promise<boolean> {
  if (!(await relationshipMemoryFeatureEnabled(db, args.orgId, args.userId))) {
    return false;
  }

  const currentTime = nowDate();
  const payload: RelationshipSyncJobPayload = {
    memorySource: {
      provider: args.provider,
      externalId: args.sourceExternalId,
    },
    ...(args.connectorId ? { connectorId: args.connectorId } : {}),
    ...(args.gmailThreadId ? { gmailThreadId: args.gmailThreadId } : {}),
    ...(args.gmailMessageIds ? { gmailMessageIds: args.gmailMessageIds } : {}),
    ...(args.historyId ? { historyId: args.historyId } : {}),
    ...(args.gmailMessage ? { gmailMessage: args.gmailMessage } : {}),
    ...(args.reason ? { reason: args.reason } : {}),
  };
  const priority = args.priority ?? 0;
  const dedupeKey = memorySourceExtractionDedupeKey({
    orgId: args.orgId,
    userId: args.userId,
    provider: args.provider,
    externalId: args.sourceExternalId,
  });
  const jobValues: typeof relationshipSyncJobs.$inferInsert = {
    orgId: args.orgId,
    userId: args.userId,
    kind: "memory_source_relationship_extract",
    provider: args.provider,
    status: "pending",
    priority,
    dedupeKey,
    payload,
    runAfterAt: currentTime,
    attempts: 0,
    createdAt: currentTime,
    updatedAt: currentTime,
  };

  if (args.replaceExisting === false) {
    const inserted = await db
      .insert(relationshipSyncJobs)
      .values(jobValues)
      .onConflictDoNothing({ target: relationshipSyncJobs.dedupeKey })
      .returning({ id: relationshipSyncJobs.id });

    if (inserted.length === 0) {
      return false;
    }
  } else {
    await db
      .insert(relationshipSyncJobs)
      .values(jobValues)
      .onConflictDoUpdate({
        target: relationshipSyncJobs.dedupeKey,
        set: {
          status: "pending",
          payload,
          priority,
          runAfterAt: currentTime,
          lockedAt: null,
          lastError: null,
          updatedAt: currentTime,
        },
      });
  }

  await db
    .insert(relationshipMemorySettings)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      provider: args.provider,
      enabled: true,
      bootstrapStatus: "pending",
      createdAt: currentTime,
      updatedAt: currentTime,
    })
    .onConflictDoUpdate({
      target: [
        relationshipMemorySettings.orgId,
        relationshipMemorySettings.userId,
        relationshipMemorySettings.provider,
      ],
      set: {
        enabled: true,
        updatedAt: currentTime,
      },
    });

  return true;
}
