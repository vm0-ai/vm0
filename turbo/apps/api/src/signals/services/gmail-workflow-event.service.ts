import { Buffer } from "node:buffer";

import { OAuth2Client } from "google-auth-library";
import { command } from "ccstate";
import { and, eq, inArray, lte, or } from "drizzle-orm";
import { z } from "zod";

import {
  gmailLabelAppliedEventConfigSchema,
  gmailNewMessageEventConfigSchema,
  type GmailLabelAppliedEventConfig,
  type GmailNewMessageEventConfig,
  type GmailWorkflowEventConfig,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { refreshGoogleToken } from "@vm0/connectors/auth-providers/oauth/google";
import { connectors } from "@vm0/db/schema/connector";
import {
  gmailProcessedEvents,
  gmailWatchStates,
} from "@vm0/db/schema/gmail-event";
import { secrets as secretsTable } from "@vm0/db/schema/secret";
import {
  workflowUserTriggerThreads,
  zeroWorkflowTriggers,
  zeroWorkflows,
} from "@vm0/db/schema/zero-workflow";

import { optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { testOverride } from "../../lib/singleton";
import { writeDb$, type Db } from "../external/db";
import { now, nowDate } from "../external/time";
import { safeJsonParse, settle } from "../utils";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "./crypto.utils";
import { workflowAutomationEnabledForOwner } from "./workflow-automation-feature-switch.service";
import {
  WorkflowEventSourceTiming,
  type WorkflowEventRunTiming,
} from "./workflow-event-source-timing.service";
import {
  buildChatOnlyWorkflowTriggerCallbacks,
  runWorkflowTriggerNow$,
  type TriggerRow,
} from "./zero-workflow-trigger-run.service";
import { workflowTriggerCanFire } from "./zero-workflow-trigger-access.service";
import { ensureWorkflowUserTriggerThread } from "./zero-workflow-user-trigger-thread.service";
import { enqueueGmailRelationshipRefreshJob } from "./relationship-memory-gmail-queue.service";

const log = logger("api:gmail-workflow-event");

const GMAIL_ACCESS_TOKEN_SECRET = "GMAIL_ACCESS_TOKEN";
const GMAIL_REFRESH_TOKEN_SECRET = "GMAIL_REFRESH_TOKEN";
const CONNECTOR_SECRET_TYPE = "connector";
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const WATCH_RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const BODY_TEXT_LIMIT = 4000;
const EXCLUDED_INBOUND_LABELS = ["SENT", "DRAFT", "TRASH", "SPAM"] as const;

type GmailMatchRules = NonNullable<GmailNewMessageEventConfig["match"]>;
type GmailTextMatch = NonNullable<GmailMatchRules["subject"]>;

const gmailWatchResponseSchema = z.object({
  historyId: z.string(),
  expiration: z.string(),
});

const gmailProfileResponseSchema = z.object({
  emailAddress: z.string(),
  historyId: z.string().optional(),
});

const gmailLabelSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const gmailLabelsResponseSchema = z.object({
  labels: z.array(gmailLabelSchema).optional(),
});

const gmailHistoryMessageSchema = z.object({
  id: z.string(),
  threadId: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
});

const gmailHistoryResponseSchema = z.object({
  history: z
    .array(
      z.object({
        id: z.string().optional(),
        messagesAdded: z
          .array(
            z.object({
              message: gmailHistoryMessageSchema,
            }),
          )
          .optional(),
        labelsAdded: z
          .array(
            z.object({
              message: gmailHistoryMessageSchema,
              labelIds: z.array(z.string()).optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
  historyId: z.string().optional(),
});

const gmailMessageHeaderSchema = z.object({
  name: z.string(),
  value: z.string(),
});

interface GmailMessagePart {
  readonly mimeType?: string;
  readonly filename?: string;
  readonly headers?: readonly z.infer<typeof gmailMessageHeaderSchema>[];
  readonly body?: {
    readonly data?: string;
    readonly attachmentId?: string;
  };
  readonly parts?: readonly GmailMessagePart[];
}

const gmailMessagePartSchema: z.ZodType<GmailMessagePart> = z.lazy(() => {
  return z.object({
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    headers: z.array(gmailMessageHeaderSchema).optional(),
    body: z
      .object({
        data: z.string().optional(),
        attachmentId: z.string().optional(),
      })
      .optional(),
    parts: z.array(gmailMessagePartSchema).optional(),
  });
});

const gmailMessageSchema = z.object({
  id: z.string(),
  threadId: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
  internalDate: z.string().optional(),
  payload: gmailMessagePartSchema.optional(),
});

const pubSubPushSchema = z.object({
  message: z.object({
    data: z.string(),
    messageId: z.string(),
  }),
  subscription: z.string().optional(),
});

const gmailPubSubDataSchema = z.object({
  emailAddress: z.string(),
  historyId: z
    .union([z.string(), z.number().int().nonnegative()])
    .transform(String),
});

interface GmailAccess {
  readonly connectorId: string;
  readonly emailAddress: string | null;
  readonly accessToken: string;
}

type GmailAccessResult =
  | { readonly kind: "ok"; readonly access: GmailAccess }
  | { readonly kind: "bad_request"; readonly message: string };

interface GmailConnectorAccessRow {
  readonly id: string;
  readonly externalEmail: string | null;
  readonly tokenExpiresAt: Date | null;
  readonly needsReconnect: boolean;
}

interface ConnectorSecretRow {
  readonly name: string;
  readonly encryptedValue: string;
}

interface GmailConnectorSecrets {
  readonly accessSecret: ConnectorSecretRow | null;
  readonly refreshSecret: ConnectorSecretRow | null;
}

type EnsureGmailWatchResult =
  | { readonly kind: "ok" }
  | { readonly kind: "bad_request"; readonly message: string };

interface GmailFetchOk<T> {
  readonly kind: "ok";
  readonly value: T;
}

interface GmailFetchError {
  readonly kind: "error";
  readonly status: number;
  readonly message: string;
}

type GmailFetchResult<T> = GmailFetchOk<T> | GmailFetchError;

interface GmailHistoryMessageAdded {
  readonly historyId: string;
  readonly messageId: string;
  readonly threadId: string | null;
  readonly labelIds: readonly string[];
}

interface GmailHistoryLabelAdded {
  readonly historyId: string;
  readonly messageId: string;
  readonly threadId: string | null;
  readonly labelIds: readonly string[];
}

type GmailHistoryMessageEvent =
  | GmailHistoryMessageAdded
  | GmailHistoryLabelAdded;

interface GmailMessageContext {
  readonly messageId: string;
  readonly threadId: string | null;
  readonly labelIds: readonly string[];
  readonly occurredAt: string | null;
  readonly from: string | null;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject: string | null;
  readonly bodyText: string | null;
}

type GmailHistoryResult =
  | {
      readonly kind: "ok";
      readonly messagesAdded: readonly GmailHistoryMessageAdded[];
      readonly labelsAdded: readonly GmailHistoryLabelAdded[];
    }
  | { readonly kind: "stale_cursor" }
  | { readonly kind: "gmail_error"; readonly message: string };

interface PubSubOidcClaims {
  readonly email: string | null;
  readonly emailVerified: boolean;
}

type PubSubOidcVerifier = (
  token: string,
  audience: string,
  signal: AbortSignal,
) => Promise<PubSubOidcClaims>;

const pubSubOidcVerifierOverride = testOverride<PubSubOidcVerifier | undefined>(
  () => {
    return undefined;
  },
);

function tokenNeedsRefresh(tokenExpiresAt: Date | null, currentTime: Date) {
  if (tokenExpiresAt === null) {
    return true;
  }
  return (
    tokenExpiresAt.getTime() <= currentTime.getTime() + TOKEN_REFRESH_BUFFER_MS
  );
}

function tokenExpiresAtFromExpiresIn(
  expiresIn: number | undefined,
  currentTime: Date,
): Date | null {
  return expiresIn === undefined
    ? null
    : new Date(currentTime.getTime() + expiresIn * 1000);
}

async function loadGmailConnector(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId?: string;
  readonly signal: AbortSignal;
}): Promise<GmailConnectorAccessRow | null> {
  const connectorConditions = [
    eq(connectors.orgId, args.orgId),
    eq(connectors.userId, args.userId),
    eq(connectors.type, "gmail"),
  ];
  if (args.connectorId !== undefined) {
    connectorConditions.push(eq(connectors.id, args.connectorId));
  }

  const [connector] = await args.db
    .select({
      id: connectors.id,
      externalEmail: connectors.externalEmail,
      tokenExpiresAt: connectors.tokenExpiresAt,
      needsReconnect: connectors.needsReconnect,
    })
    .from(connectors)
    .where(and(...connectorConditions))
    .limit(1);
  args.signal.throwIfAborted();

  return connector ?? null;
}

async function loadGmailConnectorSecrets(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly signal: AbortSignal;
}): Promise<GmailConnectorSecrets> {
  const secretRows = await args.db
    .select({
      name: secretsTable.name,
      encryptedValue: secretsTable.encryptedValue,
    })
    .from(secretsTable)
    .where(
      and(
        eq(secretsTable.orgId, args.orgId),
        eq(secretsTable.userId, args.userId),
        eq(secretsTable.type, CONNECTOR_SECRET_TYPE),
      ),
    );
  args.signal.throwIfAborted();

  return {
    accessSecret:
      secretRows.find((row) => {
        return row.name === GMAIL_ACCESS_TOKEN_SECRET;
      }) ?? null,
    refreshSecret:
      secretRows.find((row) => {
        return row.name === GMAIL_REFRESH_TOKEN_SECRET;
      }) ?? null,
  };
}

async function markGmailConnectorNeedsReconnect(args: {
  readonly db: Db;
  readonly connectorId: string;
  readonly currentTime: Date;
  readonly signal: AbortSignal;
}): Promise<void> {
  await args.db
    .update(connectors)
    .set({ needsReconnect: true, updatedAt: args.currentTime })
    .where(eq(connectors.id, args.connectorId));
  args.signal.throwIfAborted();
}

async function refreshGmailAccessToken(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connector: GmailConnectorAccessRow;
  readonly refreshSecret: ConnectorSecretRow;
  readonly currentTime: Date;
  readonly signal: AbortSignal;
}): Promise<GmailAccessResult> {
  const clientId = optionalEnv("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = optionalEnv("GOOGLE_OAUTH_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return {
      kind: "bad_request",
      message: "Google OAuth client env vars are not configured",
    };
  }

  const refreshToken = await decryptStoredSecretValue(
    args.refreshSecret.encryptedValue,
  );
  const refreshResult = await settle(
    refreshGoogleToken(
      "gmail",
      clientId,
      clientSecret,
      refreshToken,
      args.signal,
    ),
    args.signal,
  );
  if (!refreshResult.ok) {
    await markGmailConnectorNeedsReconnect({
      db: args.db,
      connectorId: args.connector.id,
      currentTime: args.currentTime,
      signal: args.signal,
    });
    return {
      kind: "bad_request",
      message: "Reconnect Gmail before using Gmail event triggers",
    };
  }

  const tokenExpiresAt = tokenExpiresAtFromExpiresIn(
    refreshResult.value.expiresIn,
    args.currentTime,
  );
  await args.db
    .update(secretsTable)
    .set({
      encryptedValue: await encryptStoredSecretValue(
        refreshResult.value.accessToken,
      ),
      updatedAt: args.currentTime,
    })
    .where(
      and(
        eq(secretsTable.orgId, args.orgId),
        eq(secretsTable.userId, args.userId),
        eq(secretsTable.type, CONNECTOR_SECRET_TYPE),
        eq(secretsTable.name, GMAIL_ACCESS_TOKEN_SECRET),
      ),
    );
  args.signal.throwIfAborted();

  await args.db
    .update(connectors)
    .set({
      tokenExpiresAt,
      needsReconnect: false,
      updatedAt: args.currentTime,
    })
    .where(eq(connectors.id, args.connector.id));
  args.signal.throwIfAborted();

  return {
    kind: "ok",
    access: {
      connectorId: args.connector.id,
      emailAddress: args.connector.externalEmail,
      accessToken: refreshResult.value.accessToken,
    },
  };
}

export async function resolveGmailAccess(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId?: string;
  readonly signal: AbortSignal;
}): Promise<GmailAccessResult> {
  const currentTime = nowDate();
  const connector = await loadGmailConnector(args);
  if (!connector) {
    return {
      kind: "bad_request",
      message: "Connect Gmail before adding a Gmail event trigger",
    };
  }
  if (connector.needsReconnect) {
    return {
      kind: "bad_request",
      message: "Reconnect Gmail before using Gmail event triggers",
    };
  }

  const { accessSecret, refreshSecret } = await loadGmailConnectorSecrets(args);
  if (!accessSecret) {
    return {
      kind: "bad_request",
      message: "Reconnect Gmail before using Gmail event triggers",
    };
  }

  if (!tokenNeedsRefresh(connector.tokenExpiresAt, currentTime)) {
    return {
      kind: "ok",
      access: {
        connectorId: connector.id,
        emailAddress: connector.externalEmail,
        accessToken: await decryptStoredSecretValue(
          accessSecret.encryptedValue,
        ),
      },
    };
  }

  if (!refreshSecret) {
    await markGmailConnectorNeedsReconnect({
      db: args.db,
      connectorId: connector.id,
      currentTime,
      signal: args.signal,
    });
    return {
      kind: "bad_request",
      message: "Reconnect Gmail before using Gmail event triggers",
    };
  }

  return await refreshGmailAccessToken({
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    connector,
    refreshSecret,
    currentTime,
    signal: args.signal,
  });
}

async function gmailFetchJson<T>(
  schema: z.ZodType<T>,
  accessToken: string,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<GmailFetchResult<T>> {
  const response = await fetch(url, {
    ...init,
    signal,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

  if (!response.ok) {
    return {
      kind: "error",
      status: response.status,
      message: await response.text(),
    };
  }

  return { kind: "ok", value: schema.parse(await response.json()) };
}

async function fetchGmailProfile(
  accessToken: string,
  signal: AbortSignal,
): Promise<GmailFetchResult<z.infer<typeof gmailProfileResponseSchema>>> {
  return await gmailFetchJson(
    gmailProfileResponseSchema,
    accessToken,
    `${GMAIL_API_BASE}/profile`,
    { method: "GET" },
    signal,
  );
}

async function fetchGmailLabels(
  accessToken: string,
  signal: AbortSignal,
): Promise<GmailFetchResult<z.infer<typeof gmailLabelsResponseSchema>>> {
  return await gmailFetchJson(
    gmailLabelsResponseSchema,
    accessToken,
    `${GMAIL_API_BASE}/labels`,
    { method: "GET" },
    signal,
  );
}

type GmailLabelResolveResult =
  | {
      readonly kind: "ok";
      readonly labelId: string;
      readonly labelName: string;
    }
  | { readonly kind: "bad_request"; readonly message: string };

async function resolveGmailLabelByName(args: {
  readonly accessToken: string;
  readonly labelName: string;
  readonly signal: AbortSignal;
}): Promise<GmailLabelResolveResult> {
  const labels = await fetchGmailLabels(args.accessToken, args.signal);
  args.signal.throwIfAborted();
  if (labels.kind !== "ok") {
    return {
      kind: "bad_request",
      message: "Failed to read Gmail labels",
    };
  }

  const matches = (labels.value.labels ?? []).filter((label) => {
    return label.name === args.labelName;
  });
  if (matches.length === 0) {
    return {
      kind: "bad_request",
      message: `Gmail label not found: ${args.labelName}`,
    };
  }
  if (matches.length > 1) {
    return {
      kind: "bad_request",
      message: `Multiple Gmail labels matched name: ${args.labelName}`,
    };
  }

  const label = matches[0]!;
  return { kind: "ok", labelId: label.id, labelName: label.name };
}

export async function resolveGmailLabelForUser(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly labelName: string;
  readonly signal: AbortSignal;
}): Promise<GmailLabelResolveResult> {
  const accessResult = await resolveGmailAccess(args);
  args.signal.throwIfAborted();
  if (accessResult.kind !== "ok") {
    return accessResult;
  }

  return await resolveGmailLabelByName({
    accessToken: accessResult.access.accessToken,
    labelName: args.labelName,
    signal: args.signal,
  });
}

async function watchGmailMailbox(args: {
  readonly accessToken: string;
  readonly topicName: string;
  readonly signal: AbortSignal;
}): Promise<GmailFetchResult<z.infer<typeof gmailWatchResponseSchema>>> {
  return await gmailFetchJson(
    gmailWatchResponseSchema,
    args.accessToken,
    `${GMAIL_API_BASE}/watch`,
    {
      method: "POST",
      body: JSON.stringify({ topicName: args.topicName }),
    },
    args.signal,
  );
}

function watchExpirationDate(expiration: string): Date {
  const millis = Number(expiration);
  if (!Number.isFinite(millis)) {
    throw new Error(`Invalid Gmail watch expiration: ${expiration}`);
  }
  return new Date(millis);
}

export async function ensureGmailWatchForUser(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly signal: AbortSignal;
}): Promise<EnsureGmailWatchResult> {
  const topicName = optionalEnv("GMAIL_PUBSUB_TOPIC_NAME");
  if (!topicName) {
    return {
      kind: "bad_request",
      message: "GMAIL_PUBSUB_TOPIC_NAME is not configured",
    };
  }

  const accessResult = await resolveGmailAccess(args);
  args.signal.throwIfAborted();
  if (accessResult.kind !== "ok") {
    return accessResult;
  }

  let emailAddress = accessResult.access.emailAddress;
  if (!emailAddress) {
    const profile = await fetchGmailProfile(
      accessResult.access.accessToken,
      args.signal,
    );
    args.signal.throwIfAborted();
    if (profile.kind !== "ok") {
      return {
        kind: "bad_request",
        message: "Failed to read Gmail profile for event trigger setup",
      };
    }
    emailAddress = profile.value.emailAddress;
  }

  const watch = await watchGmailMailbox({
    accessToken: accessResult.access.accessToken,
    topicName,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  if (watch.kind !== "ok") {
    return {
      kind: "bad_request",
      message: "Failed to register Gmail watch for event trigger setup",
    };
  }

  const currentTime = nowDate();
  await args.db
    .insert(gmailWatchStates)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      connectorId: accessResult.access.connectorId,
      emailAddress,
      topicName,
      lastHistoryId: watch.value.historyId,
      watchExpirationAt: watchExpirationDate(watch.value.expiration),
      lastWatchRenewedAt: currentTime,
      needsRewatch: false,
      createdAt: currentTime,
      updatedAt: currentTime,
    })
    .onConflictDoUpdate({
      target: [gmailWatchStates.connectorId, gmailWatchStates.topicName],
      set: {
        emailAddress,
        lastHistoryId: watch.value.historyId,
        watchExpirationAt: watchExpirationDate(watch.value.expiration),
        lastWatchRenewedAt: currentTime,
        needsRewatch: false,
        updatedAt: currentTime,
      },
    });
  args.signal.throwIfAborted();

  return { kind: "ok" };
}

async function listGmailHistory(args: {
  readonly accessToken: string;
  readonly startHistoryId: string;
  readonly signal: AbortSignal;
}): Promise<GmailHistoryResult> {
  let pageToken: string | null = null;
  const messagesAdded: GmailHistoryMessageAdded[] = [];
  const labelsAdded: GmailHistoryLabelAdded[] = [];

  do {
    const url = new URL(`${GMAIL_API_BASE}/history`);
    url.searchParams.set("startHistoryId", args.startHistoryId);
    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }

    const result = await gmailFetchJson(
      gmailHistoryResponseSchema,
      args.accessToken,
      url.toString(),
      { method: "GET" },
      args.signal,
    );
    args.signal.throwIfAborted();

    if (result.kind !== "ok") {
      return result.status === 404
        ? { kind: "stale_cursor" }
        : { kind: "gmail_error", message: result.message };
    }

    for (const history of result.value.history ?? []) {
      for (const added of history.messagesAdded ?? []) {
        messagesAdded.push({
          historyId: history.id ?? args.startHistoryId,
          messageId: added.message.id,
          threadId: added.message.threadId ?? null,
          labelIds: added.message.labelIds ?? [],
        });
      }
      for (const added of history.labelsAdded ?? []) {
        labelsAdded.push({
          historyId: history.id ?? args.startHistoryId,
          messageId: added.message.id,
          threadId: added.message.threadId ?? null,
          labelIds:
            added.labelIds && added.labelIds.length > 0
              ? added.labelIds
              : (added.message.labelIds ?? []),
        });
      }
    }
    pageToken = result.value.nextPageToken ?? null;
  } while (pageToken);

  return { kind: "ok", messagesAdded, labelsAdded };
}

function headerValues(
  headers: readonly { readonly name: string; readonly value: string }[],
  name: string,
): readonly string[] {
  return headers
    .filter((candidate) => {
      return candidate.name.toLowerCase() === name.toLowerCase();
    })
    .map((candidate) => {
      return candidate.value;
    });
}

function firstHeaderValue(
  headers: readonly { readonly name: string; readonly value: string }[],
  name: string,
): string | null {
  return headerValues(headers, name)[0] ?? null;
}

function gmailMessageOccurredAt(
  internalDate: string | undefined,
): string | null {
  if (internalDate) {
    const millis = Number(internalDate);
    if (Number.isFinite(millis)) {
      const date = new Date(millis);
      if (!Number.isNaN(date.getTime())) {
        return date.toISOString();
      }
    }
  }

  return null;
}

function decodeGmailBodyData(data: string): string {
  return Buffer.from(
    data.replaceAll("-", "+").replaceAll("_", "/"),
    "base64",
  ).toString("utf8");
}

function collectBodyText(part: GmailMessagePart | undefined): string {
  if (!part) {
    return "";
  }
  const ownText =
    part.body?.data &&
    (part.mimeType === "text/plain" || part.mimeType === "text/html")
      ? decodeGmailBodyData(part.body.data)
      : "";
  const childText = (part.parts ?? [])
    .map((child) => {
      return collectBodyText(child);
    })
    .filter((text) => {
      return text.length > 0;
    })
    .join("\n");
  return [ownText, childText]
    .filter((text) => {
      return text.length > 0;
    })
    .join("\n");
}

export function messageIsInbound(message: GmailMessageContext): boolean {
  const labels = new Set(message.labelIds);
  if (!labels.has("INBOX")) {
    return false;
  }
  return !EXCLUDED_INBOUND_LABELS.some((label) => {
    return labels.has(label);
  });
}

async function fetchGmailMessageContext(args: {
  readonly accessToken: string;
  readonly event: GmailHistoryMessageEvent;
  readonly signal: AbortSignal;
}): Promise<GmailMessageContext | null> {
  const url = new URL(`${GMAIL_API_BASE}/messages/${args.event.messageId}`);
  url.searchParams.set("format", "full");
  url.searchParams.append("metadataHeaders", "From");
  url.searchParams.append("metadataHeaders", "To");
  url.searchParams.append("metadataHeaders", "Cc");
  url.searchParams.append("metadataHeaders", "Subject");

  const result = await gmailFetchJson(
    gmailMessageSchema,
    args.accessToken,
    url.toString(),
    { method: "GET" },
    args.signal,
  );
  args.signal.throwIfAborted();

  if (result.kind !== "ok") {
    return null;
  }

  const headers = result.value.payload?.headers ?? [];
  const bodyText = collectBodyText(result.value.payload).slice(
    0,
    BODY_TEXT_LIMIT,
  );
  return {
    messageId: result.value.id,
    threadId: result.value.threadId ?? null,
    labelIds: result.value.labelIds ?? [],
    occurredAt: gmailMessageOccurredAt(result.value.internalDate),
    from: firstHeaderValue(headers, "From"),
    to: headerValues(headers, "To"),
    cc: headerValues(headers, "Cc"),
    subject: firstHeaderValue(headers, "Subject"),
    bodyText: bodyText.length > 0 ? bodyText : null,
  };
}

export async function fetchGmailMessageContextById(args: {
  readonly accessToken: string;
  readonly messageId: string;
  readonly threadId: string | null;
  readonly labelIds: readonly string[];
  readonly historyId?: string;
  readonly signal: AbortSignal;
}): Promise<GmailMessageContext | null> {
  return await fetchGmailMessageContext({
    accessToken: args.accessToken,
    event: {
      historyId: args.historyId ?? args.messageId,
      messageId: args.messageId,
      threadId: args.threadId,
      labelIds: args.labelIds,
    },
    signal: args.signal,
  });
}

function includesIgnoreCase(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function textMatches(value: string | null, matcher: GmailTextMatch): boolean {
  const text = value ?? "";
  if (matcher.contains && !includesIgnoreCase(text, matcher.contains)) {
    return false;
  }
  if (
    matcher.containsAny &&
    !matcher.containsAny.some((needle) => {
      return includesIgnoreCase(text, needle);
    })
  ) {
    return false;
  }
  if (
    matcher.doesNotContain &&
    includesIgnoreCase(text, matcher.doesNotContain)
  ) {
    return false;
  }
  if (
    matcher.doesNotContainAny?.some((needle) => {
      return includesIgnoreCase(text, needle);
    })
  ) {
    return false;
  }
  return true;
}

function gmailMessageMatchesConfig(
  message: GmailMessageContext,
  config: GmailNewMessageEventConfig,
): boolean {
  const match = config.match;
  if (!match) {
    return true;
  }
  if (match.from && !textMatches(message.from, match.from)) {
    return false;
  }
  if (match.subject && !textMatches(message.subject, match.subject)) {
    return false;
  }
  if (match.body && !textMatches(message.bodyText, match.body)) {
    return false;
  }
  if (match.to && !textMatches(message.to.join(", "), match.to)) {
    return false;
  }
  if (match.cc && !textMatches(message.cc.join(", "), match.cc)) {
    return false;
  }
  return true;
}

async function defaultPubSubOidcVerifier(
  token: string,
  audience: string,
  signal: AbortSignal,
): Promise<PubSubOidcClaims> {
  const client = new OAuth2Client();
  const ticket = await client.verifyIdToken({ idToken: token, audience });
  signal.throwIfAborted();
  const payload = ticket.getPayload();
  return {
    email: payload?.email ?? null,
    emailVerified: payload?.email_verified === true,
  };
}

async function verifyPubSubOidc(args: {
  readonly authorization: string | null;
  readonly signal: AbortSignal;
}): Promise<
  | { readonly kind: "ok" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "config_error"; readonly message: string }
> {
  const audience = optionalEnv("GMAIL_PUBSUB_PUSH_AUDIENCE");
  const expectedEmail = optionalEnv("GMAIL_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL");
  if (!audience || !expectedEmail) {
    return {
      kind: "config_error",
      message: "Gmail Pub/Sub push OIDC env vars are not configured",
    };
  }

  if (!args.authorization?.startsWith("Bearer ")) {
    return { kind: "unauthorized" };
  }

  const token = args.authorization.slice("Bearer ".length);
  const verifier =
    pubSubOidcVerifierOverride.get() ?? defaultPubSubOidcVerifier;
  const claimsResult = await settle(verifier(token, audience, args.signal));
  args.signal.throwIfAborted();
  if (!claimsResult.ok) {
    return { kind: "unauthorized" };
  }

  return claimsResult.value.email === expectedEmail &&
    claimsResult.value.emailVerified
    ? { kind: "ok" }
    : { kind: "unauthorized" };
}

function decodePubSubPush(rawBody: string):
  | {
      readonly kind: "ok";
      readonly messageId: string;
      readonly emailAddress: string;
      readonly historyId: string;
    }
  | { readonly kind: "bad_request"; readonly message: string } {
  const rawPush = safeJsonParse(rawBody);
  if (rawPush === undefined) {
    return { kind: "bad_request", message: "Invalid Pub/Sub push payload" };
  }
  const push = pubSubPushSchema.safeParse(rawPush);
  if (!push.success) {
    return { kind: "bad_request", message: "Invalid Pub/Sub push payload" };
  }
  const decoded = Buffer.from(push.data.message.data, "base64").toString(
    "utf8",
  );
  const rawData = safeJsonParse(decoded);
  if (rawData === undefined) {
    return { kind: "bad_request", message: "Invalid Gmail Pub/Sub data" };
  }
  const data = gmailPubSubDataSchema.safeParse(rawData);
  if (!data.success) {
    return { kind: "bad_request", message: "Invalid Gmail Pub/Sub data" };
  }
  return {
    kind: "ok",
    messageId: push.data.message.messageId,
    emailAddress: data.data.emailAddress,
    historyId: data.data.historyId,
  };
}

type GmailPubSubPushResult =
  | {
      readonly kind: "ok";
      readonly watchStates: number;
      readonly dispatched: number;
      readonly duplicates: number;
    }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "bad_request"; readonly message: string }
  | { readonly kind: "config_error"; readonly message: string }
  | { readonly kind: "run_error"; readonly message: string };

type DecodedGmailPubSubPush = Extract<
  ReturnType<typeof decodePubSubPush>,
  { readonly kind: "ok" }
>;

type GmailWatchStateRow = typeof gmailWatchStates.$inferSelect;

interface GmailEventTriggerRow {
  readonly trigger: TriggerRow;
  readonly agentId: string;
  readonly workflowName: string;
  readonly chatThreadId: string;
  readonly config: GmailWorkflowEventConfig;
}

type GmailFeatureGateChecker = (
  orgId: string,
  userId: string,
) => Promise<boolean>;

type GmailRunStarter = (args: {
  readonly trigger: GmailEventTriggerRow;
  readonly decoded: DecodedGmailPubSubPush;
  readonly message: GmailMessageContext;
  readonly timing: WorkflowEventRunTiming;
}) => Promise<"ok" | "error">;

interface GmailWorkflowRunStartTestInput {
  readonly triggerId: string;
  readonly workflowName: string;
  readonly emailAddress: string;
  readonly messageId: string;
  readonly threadId: string | null;
  readonly subject: string | null;
  readonly triggerBrief: string;
}

type GmailRunStarterTestOverride = (
  args: GmailWorkflowRunStartTestInput,
) => Promise<"ok" | "error">;

const gmailRunStarterOverride = testOverride<
  GmailRunStarterTestOverride | undefined
>(() => {
  return undefined;
});

type GmailDispatchStateResult =
  | {
      readonly kind: "ok";
      readonly dispatched: number;
      readonly duplicates: number;
    }
  | { readonly kind: "run_error"; readonly message: string };

async function loadGmailWatchStates(args: {
  readonly db: Db;
  readonly decoded: DecodedGmailPubSubPush;
  readonly topicName: string;
  readonly signal: AbortSignal;
}): Promise<GmailWatchStateRow[]> {
  const states = await args.db
    .select()
    .from(gmailWatchStates)
    .where(
      and(
        eq(gmailWatchStates.emailAddress, args.decoded.emailAddress),
        eq(gmailWatchStates.topicName, args.topicName),
      ),
    );
  args.signal.throwIfAborted();

  return states;
}

async function renewStaleGmailWatchState(args: {
  readonly db: Db;
  readonly state: GmailWatchStateRow;
  readonly accessToken: string;
  readonly topicName: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  const watch = await watchGmailMailbox({
    accessToken: args.accessToken,
    topicName: args.topicName,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  if (watch.kind !== "ok") {
    return;
  }

  const currentTime = nowDate();
  await args.db
    .update(gmailWatchStates)
    .set({
      lastHistoryId: watch.value.historyId,
      watchExpirationAt: watchExpirationDate(watch.value.expiration),
      lastWatchRenewedAt: currentTime,
      needsRewatch: false,
      updatedAt: currentTime,
    })
    .where(eq(gmailWatchStates.id, args.state.id));
  args.signal.throwIfAborted();
}

async function loadGmailEventTriggers(args: {
  readonly db: Db;
  readonly state: GmailWatchStateRow;
  readonly signal: AbortSignal;
}): Promise<GmailEventTriggerRow[]> {
  const triggerRows = await args.db
    .select({
      trigger: zeroWorkflowTriggers,
      agentId: zeroWorkflows.agentId,
      workflowName: zeroWorkflows.name,
      workflowDisplayName: zeroWorkflows.displayName,
      chatThreadId: workflowUserTriggerThreads.chatThreadId,
    })
    .from(zeroWorkflowTriggers)
    .innerJoin(
      zeroWorkflows,
      eq(zeroWorkflowTriggers.workflowId, zeroWorkflows.id),
    )
    .leftJoin(
      workflowUserTriggerThreads,
      and(
        eq(workflowUserTriggerThreads.orgId, zeroWorkflowTriggers.orgId),
        eq(workflowUserTriggerThreads.userId, zeroWorkflowTriggers.ownerUserId),
        eq(
          workflowUserTriggerThreads.workflowId,
          zeroWorkflowTriggers.workflowId,
        ),
      ),
    )
    .where(
      and(
        eq(zeroWorkflowTriggers.orgId, args.state.orgId),
        eq(zeroWorkflowTriggers.ownerUserId, args.state.userId),
        eq(zeroWorkflowTriggers.enabled, true),
        eq(zeroWorkflowTriggers.kind, "event"),
        inArray(zeroWorkflowTriggers.eventType, [
          "gmail-new-message",
          "gmail-label-applied",
        ]),
      ),
    );
  args.signal.throwIfAborted();

  const currentTime = nowDate();
  const triggers: GmailEventTriggerRow[] = [];
  for (const row of triggerRows) {
    const config =
      row.trigger.eventType === "gmail-label-applied"
        ? gmailLabelAppliedEventConfigSchema.safeParse(row.trigger.eventConfig)
        : gmailNewMessageEventConfigSchema.safeParse(row.trigger.eventConfig);
    if (!config.success) {
      continue;
    }
    const canFire = await workflowTriggerCanFire(args.db, {
      trigger: row.trigger,
      agentId: row.agentId,
      signal: args.signal,
    });
    args.signal.throwIfAborted();
    if (!canFire) {
      continue;
    }
    const chatThreadId =
      row.chatThreadId ??
      (await args.db.transaction(async (tx) => {
        return await ensureWorkflowUserTriggerThread(tx, {
          orgId: row.trigger.orgId,
          userId: row.trigger.ownerUserId,
          workflowId: row.trigger.workflowId,
          agentId: row.agentId,
          workflowTitle: row.workflowDisplayName ?? row.workflowName,
          currentTime,
        });
      }));
    args.signal.throwIfAborted();
    triggers.push({
      trigger: row.trigger,
      agentId: row.agentId,
      workflowName: row.workflowName,
      chatThreadId,
      config: config.data,
    });
  }
  return triggers;
}

async function cachedGmailMessageContext(args: {
  readonly cache: Map<string, GmailMessageContext | null>;
  readonly accessToken: string;
  readonly event: GmailHistoryMessageEvent;
  readonly signal: AbortSignal;
}): Promise<GmailMessageContext | null> {
  const cached = args.cache.get(args.event.messageId);
  if (cached !== undefined) {
    return cached;
  }

  const message = await fetchGmailMessageContext({
    accessToken: args.accessToken,
    event: args.event,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  args.cache.set(args.event.messageId, message);

  return message;
}

async function insertGmailProcessedEvent(args: {
  readonly db: Db;
  readonly state: GmailWatchStateRow;
  readonly trigger: GmailEventTriggerRow;
  readonly decoded: DecodedGmailPubSubPush;
  readonly event: GmailHistoryMessageEvent;
  readonly message: GmailMessageContext;
  readonly signal: AbortSignal;
}): Promise<string | null> {
  const [processed] = await args.db
    .insert(gmailProcessedEvents)
    .values({
      watchStateId: args.state.id,
      triggerId: args.trigger.trigger.id,
      pubsubMessageId: args.decoded.messageId,
      historyId: args.event.historyId,
      messageId: args.event.messageId,
      threadId: args.message.threadId,
      createdAt: nowDate(),
    })
    .onConflictDoNothing()
    .returning({ id: gmailProcessedEvents.id });
  args.signal.throwIfAborted();

  return processed?.id ?? null;
}

function buildGmailWorkflowEventSystemPrompt(args: {
  readonly triggerId: string;
  readonly triggerConfig: GmailWorkflowEventConfig;
  readonly emailAddress: string;
  readonly message: GmailMessageContext;
}): string {
  const triggerContext =
    args.triggerConfig.event === "label_applied"
      ? `You are running because the Gmail label "${args.triggerConfig.labelName}" was applied to a message.`
      : "You are running because a Gmail new-message workflow event trigger matched a new inbound email.";
  return [
    "# Current context",
    triggerContext,
    "The workflow's procedure is available as a skill - execute it now.",
    "This run is linked to a web chat thread; everything you output is shown to the user there.",
    "Use connected Gmail tools to inspect the message or thread if the workflow needs more detail.",
    "Do not send email automatically. If the workflow involves email response work, draft or prepare the response unless a later explicit product permission model allows sending.",
    "",
    "# Gmail event",
    JSON.stringify(
      {
        triggerId: args.triggerId,
        event: args.triggerConfig.event,
        labelName:
          args.triggerConfig.event === "label_applied"
            ? args.triggerConfig.labelName
            : undefined,
        emailAddress: args.emailAddress,
        messageId: args.message.messageId,
        threadId: args.message.threadId,
        from: args.message.from,
        to: args.message.to,
        cc: args.message.cc,
        subject: args.message.subject,
        bodyText: args.message.bodyText,
      },
      null,
      2,
    ),
  ].join("\n");
}

function buildGmailWorkflowTriggerBrief(args: {
  readonly triggerConfig: GmailWorkflowEventConfig;
  readonly message: {
    readonly messageId: string;
    readonly threadId: string | null;
    readonly from: string | null;
    readonly subject: string | null;
  };
}): string {
  const title =
    args.triggerConfig.event === "label_applied"
      ? `Gmail label applied: ${args.triggerConfig.labelName}`
      : "Gmail new message";
  return [
    title,
    `From: ${args.message.from?.trim() || "Unknown sender"}`,
    `Subject: ${args.message.subject?.trim() || "(no subject)"}`,
  ].join("\n");
}

async function dispatchGmailTriggerEvent(args: {
  readonly db: Db;
  readonly state: GmailWatchStateRow;
  readonly trigger: GmailEventTriggerRow;
  readonly decoded: DecodedGmailPubSubPush;
  readonly event: GmailHistoryMessageAdded;
  readonly message: GmailMessageContext;
  readonly timing: WorkflowEventRunTiming;
  readonly startRun: GmailRunStarter;
  readonly signal: AbortSignal;
}): Promise<"dispatched" | "duplicate" | { readonly kind: "run_error" }> {
  const processedId = await args.timing.measure(
    "api_dispatch_pre_create_zero_workflow_event_record_processed_event",
    async () => {
      return await insertGmailProcessedEvent(args);
    },
  );
  if (!processedId) {
    return "duplicate";
  }

  const result = await args.startRun({
    trigger: args.trigger,
    decoded: args.decoded,
    message: args.message,
    timing: args.timing,
  });
  args.signal.throwIfAborted();
  if (result !== "ok") {
    await args.db
      .delete(gmailProcessedEvents)
      .where(eq(gmailProcessedEvents.id, processedId));
    args.signal.throwIfAborted();
    return { kind: "run_error" };
  }

  return "dispatched";
}

function isGmailNewMessageTrigger(
  trigger: GmailEventTriggerRow,
): trigger is GmailEventTriggerRow & {
  readonly config: GmailNewMessageEventConfig;
} {
  return trigger.config.event === "new_message";
}

function isGmailLabelAppliedTrigger(
  trigger: GmailEventTriggerRow,
): trigger is GmailEventTriggerRow & {
  readonly config: GmailLabelAppliedEventConfig;
} {
  return trigger.config.event === "label_applied";
}

async function updateResolvedGmailLabelId(args: {
  readonly db: Db;
  readonly trigger: GmailEventTriggerRow & {
    readonly config: GmailLabelAppliedEventConfig;
  };
  readonly labelId: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (args.trigger.config.resolvedLabelId === args.labelId) {
    return;
  }

  await args.db
    .update(zeroWorkflowTriggers)
    .set({
      eventConfig: {
        ...args.trigger.config,
        resolvedLabelId: args.labelId,
      },
      updatedAt: nowDate(),
    })
    .where(eq(zeroWorkflowTriggers.id, args.trigger.trigger.id));
  args.signal.throwIfAborted();
}

async function labelAppliedTriggerMatchesEvent(args: {
  readonly db: Db;
  readonly accessToken: string;
  readonly trigger: GmailEventTriggerRow & {
    readonly config: GmailLabelAppliedEventConfig;
  };
  readonly event: GmailHistoryLabelAdded;
  readonly labelCache: Map<string, GmailLabelResolveResult>;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  const eventLabelIds = new Set(args.event.labelIds);
  const resolvedLabelId = args.trigger.config.resolvedLabelId;
  if (resolvedLabelId && eventLabelIds.has(resolvedLabelId)) {
    return true;
  }

  const labelName = args.trigger.config.labelName;
  const cached = args.labelCache.get(labelName);
  const label =
    cached ??
    (await resolveGmailLabelByName({
      accessToken: args.accessToken,
      labelName,
      signal: args.signal,
    }));
  args.signal.throwIfAborted();
  if (!cached) {
    args.labelCache.set(labelName, label);
  }
  if (label.kind !== "ok") {
    log.warn("Gmail label event skipped because label lookup failed", {
      triggerId: args.trigger.trigger.id,
      labelName,
      message: label.message,
    });
    return false;
  }
  if (!eventLabelIds.has(label.labelId)) {
    return false;
  }

  await updateResolvedGmailLabelId({
    db: args.db,
    trigger: args.trigger,
    labelId: label.labelId,
    signal: args.signal,
  });
  return true;
}

async function dispatchGmailNewMessageHistoryEvent(args: {
  readonly db: Db;
  readonly state: GmailWatchStateRow;
  readonly decoded: DecodedGmailPubSubPush;
  readonly accessToken: string;
  readonly triggers: readonly GmailEventTriggerRow[];
  readonly event: GmailHistoryMessageAdded;
  readonly messageCache: Map<string, GmailMessageContext | null>;
  readonly sourceTiming: WorkflowEventSourceTiming;
  readonly startRun: GmailRunStarter;
  readonly signal: AbortSignal;
}): Promise<GmailDispatchStateResult> {
  const message = await args.sourceTiming.measure(
    "api_dispatch_pre_create_zero_workflow_event_load_external_events",
    async () => {
      return await cachedGmailMessageContext({
        cache: args.messageCache,
        accessToken: args.accessToken,
        event: args.event,
        signal: args.signal,
      });
    },
  );
  if (!message || !messageIsInbound(message)) {
    return { kind: "ok", dispatched: 0, duplicates: 0 };
  }

  if (message.occurredAt) {
    const relationshipJob = await settle(
      enqueueGmailRelationshipRefreshJob(args.db, {
        orgId: args.state.orgId,
        userId: args.state.userId,
        connectorId: args.state.connectorId,
        message: {
          mailboxEmail: args.decoded.emailAddress,
          historyId: args.event.historyId,
          messageId: message.messageId,
          threadId: message.threadId,
          occurredAt: message.occurredAt,
          direction: "received",
          from: message.from,
          to: message.to,
          cc: message.cc,
          subject: message.subject,
          bodyText: message.bodyText,
        },
      }),
    );
    if (!relationshipJob.ok) {
      log.warn("Failed to enqueue Gmail relationship memory refresh", {
        watchStateId: args.state.id,
        messageId: message.messageId,
        error:
          relationshipJob.error instanceof Error
            ? relationshipJob.error.message
            : String(relationshipJob.error),
      });
    }
  } else {
    log.warn("Skipped Gmail relationship memory refresh without message time", {
      watchStateId: args.state.id,
      messageId: message.messageId,
    });
  }

  let dispatched = 0;
  let duplicates = 0;

  for (const trigger of args.triggers) {
    const runTiming = args.sourceTiming.createRunTiming();
    const matches = await runTiming.measure(
      "api_dispatch_pre_create_zero_workflow_event_match_triggers",
      () => {
        return (
          isGmailNewMessageTrigger(trigger) &&
          gmailMessageMatchesConfig(message, trigger.config)
        );
      },
    );
    if (!matches) {
      continue;
    }
    const result = await dispatchGmailTriggerEvent({
      db: args.db,
      state: args.state,
      trigger,
      decoded: args.decoded,
      event: args.event,
      message,
      timing: runTiming,
      startRun: args.startRun,
      signal: args.signal,
    });
    if (typeof result !== "string") {
      return {
        kind: "run_error",
        message: "Failed to start Gmail event workflow run",
      };
    }
    dispatched += result === "dispatched" ? 1 : 0;
    duplicates += result === "duplicate" ? 1 : 0;
  }

  return { kind: "ok", dispatched, duplicates };
}

async function dispatchGmailLabelAppliedHistoryEvent(args: {
  readonly db: Db;
  readonly state: GmailWatchStateRow;
  readonly decoded: DecodedGmailPubSubPush;
  readonly accessToken: string;
  readonly triggers: readonly GmailEventTriggerRow[];
  readonly event: GmailHistoryLabelAdded;
  readonly messageCache: Map<string, GmailMessageContext | null>;
  readonly labelCache: Map<string, GmailLabelResolveResult>;
  readonly sourceTiming: WorkflowEventSourceTiming;
  readonly startRun: GmailRunStarter;
  readonly signal: AbortSignal;
}): Promise<GmailDispatchStateResult> {
  const labelTriggers = args.triggers.filter(isGmailLabelAppliedTrigger);
  if (labelTriggers.length === 0 || args.event.labelIds.length === 0) {
    return { kind: "ok", dispatched: 0, duplicates: 0 };
  }

  const matchingTriggers: {
    readonly trigger: (typeof labelTriggers)[number];
    readonly timing: WorkflowEventRunTiming;
  }[] = [];
  for (const trigger of labelTriggers) {
    const runTiming = args.sourceTiming.createRunTiming();
    const matches = await runTiming.measure(
      "api_dispatch_pre_create_zero_workflow_event_match_triggers",
      async () => {
        return await labelAppliedTriggerMatchesEvent({
          db: args.db,
          accessToken: args.accessToken,
          trigger,
          event: args.event,
          labelCache: args.labelCache,
          signal: args.signal,
        });
      },
    );
    if (matches) {
      matchingTriggers.push({ trigger, timing: runTiming });
    }
  }
  if (matchingTriggers.length === 0) {
    return { kind: "ok", dispatched: 0, duplicates: 0 };
  }

  const messageStartedAt = now();
  const message = await cachedGmailMessageContext({
    cache: args.messageCache,
    accessToken: args.accessToken,
    event: args.event,
    signal: args.signal,
  });
  const messageFinishedAt = now();
  if (!message) {
    return { kind: "ok", dispatched: 0, duplicates: 0 };
  }

  let dispatched = 0;
  let duplicates = 0;

  for (const match of matchingTriggers) {
    match.timing.recordElapsed(
      "api_dispatch_pre_create_zero_workflow_event_load_external_events",
      messageStartedAt,
      messageFinishedAt,
    );
    const result = await dispatchGmailTriggerEvent({
      db: args.db,
      state: args.state,
      trigger: match.trigger,
      decoded: args.decoded,
      event: args.event,
      message,
      timing: match.timing,
      startRun: args.startRun,
      signal: args.signal,
    });
    if (typeof result !== "string") {
      return {
        kind: "run_error",
        message: "Failed to start Gmail event workflow run",
      };
    }
    dispatched += result === "dispatched" ? 1 : 0;
    duplicates += result === "duplicate" ? 1 : 0;
  }

  return { kind: "ok", dispatched, duplicates };
}

async function dispatchGmailHistoryEvents(args: {
  readonly db: Db;
  readonly state: GmailWatchStateRow;
  readonly decoded: DecodedGmailPubSubPush;
  readonly accessToken: string;
  readonly history: Extract<GmailHistoryResult, { readonly kind: "ok" }>;
  readonly triggers: readonly GmailEventTriggerRow[];
  readonly sourceTiming: WorkflowEventSourceTiming;
  readonly startRun: GmailRunStarter;
  readonly signal: AbortSignal;
}): Promise<GmailDispatchStateResult> {
  const messageCache = new Map<string, GmailMessageContext | null>();
  const labelCache = new Map<string, GmailLabelResolveResult>();
  let dispatched = 0;
  let duplicates = 0;

  for (const event of args.history.messagesAdded) {
    const result = await dispatchGmailNewMessageHistoryEvent({
      db: args.db,
      state: args.state,
      decoded: args.decoded,
      accessToken: args.accessToken,
      triggers: args.triggers,
      event,
      messageCache,
      sourceTiming: args.sourceTiming.fork(),
      startRun: args.startRun,
      signal: args.signal,
    });
    if (result.kind !== "ok") {
      return result;
    }
    dispatched += result.dispatched;
    duplicates += result.duplicates;
  }

  for (const event of args.history.labelsAdded) {
    const result = await dispatchGmailLabelAppliedHistoryEvent({
      db: args.db,
      state: args.state,
      decoded: args.decoded,
      accessToken: args.accessToken,
      triggers: args.triggers,
      event,
      messageCache,
      labelCache,
      sourceTiming: args.sourceTiming.fork(),
      startRun: args.startRun,
      signal: args.signal,
    });
    if (result.kind !== "ok") {
      return result;
    }
    dispatched += result.dispatched;
    duplicates += result.duplicates;
  }

  return { kind: "ok", dispatched, duplicates };
}

async function dispatchGmailWatchState(args: {
  readonly db: Db;
  readonly state: GmailWatchStateRow;
  readonly decoded: DecodedGmailPubSubPush;
  readonly topicName: string;
  readonly isFeatureEnabledForOwner: GmailFeatureGateChecker;
  readonly sourceTiming: WorkflowEventSourceTiming;
  readonly startRun: GmailRunStarter;
  readonly signal: AbortSignal;
}): Promise<GmailDispatchStateResult> {
  const gateEnabled = await args.sourceTiming.measure(
    "api_dispatch_pre_create_zero_workflow_event_check_feature_gate",
    async () => {
      return await args.isFeatureEnabledForOwner(
        args.state.orgId,
        args.state.userId,
      );
    },
  );
  args.signal.throwIfAborted();
  if (!gateEnabled) {
    return { kind: "ok", dispatched: 0, duplicates: 0 };
  }

  const access = await args.sourceTiming.measure(
    "api_dispatch_pre_create_zero_workflow_event_load_source_state",
    async () => {
      return await resolveGmailAccess({
        db: args.db,
        orgId: args.state.orgId,
        userId: args.state.userId,
        connectorId: args.state.connectorId,
        signal: args.signal,
      });
    },
  );
  args.signal.throwIfAborted();
  if (access.kind !== "ok") {
    log.warn("Gmail event skipped because connector access is unavailable", {
      watchStateId: args.state.id,
      message: access.message,
    });
    return { kind: "ok", dispatched: 0, duplicates: 0 };
  }

  const history = await args.sourceTiming.measure(
    "api_dispatch_pre_create_zero_workflow_event_load_external_events",
    async () => {
      return await listGmailHistory({
        accessToken: access.access.accessToken,
        startHistoryId: args.state.lastHistoryId,
        signal: args.signal,
      });
    },
  );
  args.signal.throwIfAborted();
  if (history.kind === "stale_cursor") {
    await renewStaleGmailWatchState({
      db: args.db,
      state: args.state,
      accessToken: access.access.accessToken,
      topicName: args.topicName,
      signal: args.signal,
    });
    return { kind: "ok", dispatched: 0, duplicates: 0 };
  }
  if (history.kind === "gmail_error") {
    log.warn("Gmail history lookup failed", {
      watchStateId: args.state.id,
      message: history.message,
    });
    return { kind: "ok", dispatched: 0, duplicates: 0 };
  }

  const triggers = await args.sourceTiming.measure(
    "api_dispatch_pre_create_zero_workflow_event_load_triggers",
    async () => {
      return await loadGmailEventTriggers(args);
    },
  );
  const result = await dispatchGmailHistoryEvents({
    db: args.db,
    state: args.state,
    decoded: args.decoded,
    accessToken: access.access.accessToken,
    history,
    triggers,
    sourceTiming: args.sourceTiming,
    startRun: args.startRun,
    signal: args.signal,
  });
  if (result.kind !== "ok") {
    return result;
  }

  await args.db
    .update(gmailWatchStates)
    .set({
      lastHistoryId: args.decoded.historyId,
      needsRewatch: false,
      updatedAt: nowDate(),
    })
    .where(eq(gmailWatchStates.id, args.state.id));
  args.signal.throwIfAborted();

  return result;
}

const startGmailWorkflowRun$ = command(
  async (
    { set },
    args: {
      readonly trigger: GmailEventTriggerRow;
      readonly decoded: DecodedGmailPubSubPush;
      readonly message: GmailMessageContext;
      readonly timing: WorkflowEventRunTiming;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<"ok" | "error"> => {
    const runInput = await args.timing.measure(
      "api_dispatch_pre_create_zero_workflow_event_build_run_input",
      () => {
        return {
          appendSystemPrompt: buildGmailWorkflowEventSystemPrompt({
            triggerId: args.trigger.trigger.id,
            triggerConfig: args.trigger.config,
            emailAddress: args.decoded.emailAddress,
            message: args.message,
          }),
          triggerBrief: buildGmailWorkflowTriggerBrief({
            triggerConfig: args.trigger.config,
            message: args.message,
          }),
          callbacks: buildChatOnlyWorkflowTriggerCallbacks(
            args.trigger.chatThreadId,
            args.trigger.agentId,
          ),
        };
      },
    );
    signal.throwIfAborted();
    const result = await set(
      runWorkflowTriggerNow$,
      {
        due: {
          trigger: args.trigger.trigger,
          agentId: args.trigger.agentId,
          workflowName: args.trigger.workflowName,
          chatThreadId: args.trigger.chatThreadId,
        },
        apiStartTime: args.apiStartTime,
        triggerSource: "workflow-event",
        appendSystemPrompt: runInput.appendSystemPrompt,
        triggerBrief: runInput.triggerBrief,
        callbacks: runInput.callbacks,
        activePreviousRunPolicy: "allow",
        recordLastRunId: false,
        recordLastRunAt: true,
        dispatchFailedCallbacks: dispatchFailedRunCallbacks,
        timing: args.timing.collectorForRunStart(),
      },
      signal,
    );
    signal.throwIfAborted();
    return result.kind === "ok" ? "ok" : "error";
  },
);

export const dispatchGmailPubSubPush$ = command(
  async (
    { get, set },
    args: {
      readonly authorization: string | null;
      readonly rawBody: string;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<GmailPubSubPushResult> => {
    const auth = await verifyPubSubOidc({
      authorization: args.authorization,
      signal,
    });
    signal.throwIfAborted();
    if (auth.kind !== "ok") {
      return auth;
    }

    const decoded = decodePubSubPush(args.rawBody);
    if (decoded.kind !== "ok") {
      return decoded;
    }

    const topicName = optionalEnv("GMAIL_PUBSUB_TOPIC_NAME");
    if (!topicName) {
      return {
        kind: "config_error",
        message: "GMAIL_PUBSUB_TOPIC_NAME is not configured",
      };
    }

    const sourceTiming = new WorkflowEventSourceTiming(
      "gmail",
      args.apiStartTime,
    );
    const db = set(writeDb$);
    const states = await sourceTiming.measure(
      "api_dispatch_pre_create_zero_workflow_event_load_source_state",
      async () => {
        return await loadGmailWatchStates({
          db,
          decoded,
          topicName,
          signal,
        });
      },
    );
    signal.throwIfAborted();
    const isFeatureEnabledForOwner: GmailFeatureGateChecker = async (
      orgId,
      userId,
    ) => {
      return await get(workflowAutomationEnabledForOwner(orgId, userId));
    };
    const runStarterOverride = gmailRunStarterOverride.get();
    const startRun: GmailRunStarter = runStarterOverride
      ? async ({ trigger, decoded, message }) => {
          return await runStarterOverride({
            triggerId: trigger.trigger.id,
            workflowName: trigger.workflowName,
            emailAddress: decoded.emailAddress,
            messageId: message.messageId,
            threadId: message.threadId,
            subject: message.subject,
            triggerBrief: buildGmailWorkflowTriggerBrief({
              triggerConfig: trigger.config,
              message,
            }),
          });
        }
      : async ({ trigger, decoded, message, timing }) => {
          return await set(
            startGmailWorkflowRun$,
            {
              trigger,
              decoded,
              message,
              timing,
              apiStartTime: args.apiStartTime,
            },
            signal,
          );
        };

    let dispatched = 0;
    let duplicates = 0;

    for (const state of states) {
      const result = await dispatchGmailWatchState({
        db,
        state,
        decoded,
        topicName,
        isFeatureEnabledForOwner,
        sourceTiming: sourceTiming.fork(),
        startRun,
        signal,
      });
      if (result.kind !== "ok") {
        return result;
      }
      dispatched += result.dispatched;
      duplicates += result.duplicates;
    }

    return {
      kind: "ok",
      watchStates: states.length,
      dispatched,
      duplicates,
    };
  },
);

export const renewGmailWatches$ = command(
  async ({ set }, signal: AbortSignal) => {
    const topicName = optionalEnv("GMAIL_PUBSUB_TOPIC_NAME");
    if (!topicName) {
      return { renewed: 0, failed: 0 };
    }

    const db = set(writeDb$);
    const currentTime = nowDate();
    const renewBefore = new Date(
      currentTime.getTime() + WATCH_RENEWAL_WINDOW_MS,
    );
    const states = await db
      .select()
      .from(gmailWatchStates)
      .where(
        and(
          eq(gmailWatchStates.topicName, topicName),
          or(
            eq(gmailWatchStates.needsRewatch, true),
            lte(gmailWatchStates.watchExpirationAt, renewBefore),
          ),
        ),
      );
    signal.throwIfAborted();

    let renewed = 0;
    let failed = 0;
    for (const state of states) {
      const access = await resolveGmailAccess({
        db,
        orgId: state.orgId,
        userId: state.userId,
        connectorId: state.connectorId,
        signal,
      });
      signal.throwIfAborted();
      if (access.kind !== "ok") {
        failed++;
        continue;
      }

      const watch = await watchGmailMailbox({
        accessToken: access.access.accessToken,
        topicName,
        signal,
      });
      signal.throwIfAborted();
      if (watch.kind !== "ok") {
        failed++;
        continue;
      }

      await db
        .update(gmailWatchStates)
        .set({
          lastHistoryId: watch.value.historyId,
          watchExpirationAt: watchExpirationDate(watch.value.expiration),
          lastWatchRenewedAt: currentTime,
          needsRewatch: false,
          updatedAt: currentTime,
        })
        .where(eq(gmailWatchStates.id, state.id));
      signal.throwIfAborted();
      renewed++;
    }

    return { renewed, failed };
  },
);
