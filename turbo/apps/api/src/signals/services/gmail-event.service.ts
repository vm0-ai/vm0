import { Buffer } from "node:buffer";

import { OAuth2Client } from "google-auth-library";
import { command, computed } from "ccstate";
import { z } from "zod";
import { and, eq, lte, or } from "drizzle-orm";
import { refreshGoogleToken } from "@vm0/connectors/auth-providers/oauth/google";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import {
  gmailNewMessageEventConfigSchema,
  type AutomationTriggerResponse,
} from "@vm0/api-contracts/contracts/automations";
import { automations, automationTriggers } from "@vm0/db/schema/automation";
import { connectors } from "@vm0/db/schema/connector";
import {
  gmailProcessedEvents,
  gmailWatchStates,
} from "@vm0/db/schema/gmail-event";
import { secrets as secretsTable } from "@vm0/db/schema/secret";

import { optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { testOverride } from "../../lib/singleton";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../external/time";
import { safeJsonParse, settle } from "../utils";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "./crypto.utils";
import { createZeroRun$ } from "./zero-runs-create.service";
import { postAutomationUserMessage } from "../routes/zero-chat-messages";
import { userFeatureSwitchOverrides } from "./feature-switches.service";
import {
  DefaultInterpreter,
  gmailRowToAutomation,
  type GmailTriggerEvent,
} from "./automations/default-interpreter";

const log = logger("api:gmail-event");

const GMAIL_ACCESS_TOKEN_SECRET = "GMAIL_ACCESS_TOKEN";
const GMAIL_REFRESH_TOKEN_SECRET = "GMAIL_REFRESH_TOKEN";
const CONNECTOR_SECRET_TYPE = "connector";
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const WATCH_RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const BODY_TEXT_LIMIT = 4000;
const EXCLUDED_INBOUND_LABELS = ["SENT", "DRAFT", "TRASH", "SPAM"] as const;

type GmailNewMessageEventConfig = z.infer<
  typeof gmailNewMessageEventConfigSchema
>;
type GmailMatchRules = NonNullable<GmailNewMessageEventConfig["match"]>;
type GmailTextMatch = NonNullable<GmailMatchRules["subject"]>;
type GmailRunInput = Awaited<ReturnType<DefaultInterpreter["interpret"]>>;
type EventTriggerResponse = Extract<
  AutomationTriggerResponse,
  { readonly kind: "event" }
>;

const gmailWatchResponseSchema = z.object({
  historyId: z.string(),
  expiration: z.string(),
});

const gmailProfileResponseSchema = z.object({
  emailAddress: z.string(),
  historyId: z.string().optional(),
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
  snippet: z.string().optional(),
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
  historyId: z.string(),
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

interface GmailMessageContext {
  readonly messageId: string;
  readonly threadId: string | null;
  readonly labelIds: readonly string[];
  readonly from: string | null;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject: string | null;
  readonly snippet: string | null;
  readonly bodyText: string | null;
  readonly hasAttachment: boolean;
}

type GmailHistoryResult =
  | {
      readonly kind: "ok";
      readonly messagesAdded: readonly GmailHistoryMessageAdded[];
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

export function setGmailPubSubOidcVerifierForTests(
  verifier: PubSubOidcVerifier,
): () => void {
  pubSubOidcVerifierOverride.set(verifier);
  return () => {
    pubSubOidcVerifierOverride.clear();
  };
}

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

async function resolveGmailAccess(args: {
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

async function listGmailMessageHistory(args: {
  readonly accessToken: string;
  readonly startHistoryId: string;
  readonly signal: AbortSignal;
}): Promise<GmailHistoryResult> {
  let pageToken: string | null = null;
  const messagesAdded: GmailHistoryMessageAdded[] = [];

  do {
    const url = new URL(`${GMAIL_API_BASE}/history`);
    url.searchParams.set("startHistoryId", args.startHistoryId);
    url.searchParams.set("historyTypes", "messageAdded");
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
    }
    pageToken = result.value.nextPageToken ?? null;
  } while (pageToken);

  return { kind: "ok", messagesAdded };
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

function partHasAttachment(part: GmailMessagePart | undefined): boolean {
  if (!part) {
    return false;
  }
  if ((part.filename?.length ?? 0) > 0 || part.body?.attachmentId) {
    return true;
  }
  return (part.parts ?? []).some((child) => {
    return partHasAttachment(child);
  });
}

function messageIsInbound(message: GmailMessageContext): boolean {
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
  readonly event: GmailHistoryMessageAdded;
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
    threadId: result.value.threadId ?? args.event.threadId,
    labelIds:
      result.value.labelIds && result.value.labelIds.length > 0
        ? result.value.labelIds
        : args.event.labelIds,
    from: firstHeaderValue(headers, "From"),
    to: headerValues(headers, "To"),
    cc: headerValues(headers, "Cc"),
    subject: firstHeaderValue(headers, "Subject"),
    snippet: result.value.snippet ?? null,
    bodyText: bodyText.length > 0 ? bodyText : null,
    hasAttachment: partHasAttachment(result.value.payload),
  };
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

function labelsMatch(
  labels: readonly string[],
  matcher: NonNullable<GmailMatchRules["labels"]>,
): boolean {
  const labelSet = new Set(labels);
  if (
    matcher.includeAny &&
    !matcher.includeAny.some((label) => {
      return labelSet.has(label);
    })
  ) {
    return false;
  }
  if (
    matcher.excludeAny?.some((label) => {
      return labelSet.has(label);
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
  if (match.snippet && !textMatches(message.snippet, match.snippet)) {
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
  if (match.labels && !labelsMatch(message.labelIds, match.labels)) {
    return false;
  }
  if (
    match.hasAttachment !== undefined &&
    match.hasAttachment !== message.hasAttachment
  ) {
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

function gmailEventTriggersEnabledForOwner(orgId: string, userId: string) {
  return computed(async (get) => {
    const overrides = await get(userFeatureSwitchOverrides(orgId, userId));
    return isFeatureEnabled(FeatureSwitchKey.AutomationGmailEventTriggers, {
      orgId,
      userId,
      overrides,
    });
  });
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
  readonly triggerId: string;
  readonly triggerConfig: unknown;
  readonly automationId: string;
  readonly agentId: string;
  readonly chatThreadId: string;
  readonly instruction: string;
  readonly appendSystemPrompt: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly orgId: string;
  readonly userId: string;
}

interface ParsedGmailEventTriggerRow extends Omit<
  GmailEventTriggerRow,
  "triggerConfig"
> {
  readonly config: EventTriggerResponse["config"];
}

type GmailRunStartResult =
  | {
      readonly kind: "ok";
      readonly runId: string;
      readonly status: string;
    }
  | { readonly kind: "error" };

type GmailRunStarter = (args: {
  readonly trigger: ParsedGmailEventTriggerRow;
  readonly runInput: GmailRunInput;
}) => Promise<GmailRunStartResult>;

type GmailFeatureGateChecker = (
  orgId: string,
  userId: string,
) => Promise<boolean>;

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
}): Promise<ParsedGmailEventTriggerRow[]> {
  const triggerRows: GmailEventTriggerRow[] = await args.db
    .select({
      triggerId: automationTriggers.id,
      triggerConfig: automationTriggers.config,
      automationId: automations.id,
      agentId: automations.agentId,
      chatThreadId: automations.chatThreadId,
      instruction: automations.instruction,
      appendSystemPrompt: automations.appendSystemPrompt,
      name: automations.name,
      description: automations.description,
      orgId: automations.orgId,
      userId: automations.userId,
    })
    .from(automationTriggers)
    .innerJoin(automations, eq(automationTriggers.automationId, automations.id))
    .where(
      and(
        eq(automations.orgId, args.state.orgId),
        eq(automations.userId, args.state.userId),
        eq(automations.enabled, true),
        eq(automationTriggers.enabled, true),
        eq(automationTriggers.kind, "event"),
      ),
    );
  args.signal.throwIfAborted();

  return triggerRows.flatMap((row) => {
    const config = gmailNewMessageEventConfigSchema.safeParse(
      row.triggerConfig,
    );
    return config.success ? [{ ...row, config: config.data }] : [];
  });
}

async function cachedGmailMessageContext(args: {
  readonly cache: Map<string, GmailMessageContext | null>;
  readonly accessToken: string;
  readonly event: GmailHistoryMessageAdded;
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
  readonly trigger: ParsedGmailEventTriggerRow;
  readonly decoded: DecodedGmailPubSubPush;
  readonly event: GmailHistoryMessageAdded;
  readonly message: GmailMessageContext;
  readonly signal: AbortSignal;
}): Promise<string | null> {
  const [processed] = await args.db
    .insert(gmailProcessedEvents)
    .values({
      watchStateId: args.state.id,
      triggerId: args.trigger.triggerId,
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

function buildGmailTriggerEvent(args: {
  readonly decoded: DecodedGmailPubSubPush;
  readonly event: GmailHistoryMessageAdded;
  readonly trigger: ParsedGmailEventTriggerRow;
  readonly message: GmailMessageContext;
}): GmailTriggerEvent {
  return {
    kind: "gmail",
    triggerId: args.trigger.triggerId,
    emailAddress: args.decoded.emailAddress,
    historyId: args.event.historyId,
    messageId: args.event.messageId,
    threadId: args.message.threadId,
    from: args.message.from,
    to: args.message.to,
    cc: args.message.cc,
    subject: args.message.subject,
    snippet: args.message.snippet,
    bodyText: args.message.bodyText,
    labelIds: args.message.labelIds,
    hasAttachment: args.message.hasAttachment,
  };
}

async function dispatchGmailTriggerEvent(args: {
  readonly db: Db;
  readonly state: GmailWatchStateRow;
  readonly trigger: ParsedGmailEventTriggerRow;
  readonly decoded: DecodedGmailPubSubPush;
  readonly event: GmailHistoryMessageAdded;
  readonly message: GmailMessageContext;
  readonly startRun: GmailRunStarter;
  readonly signal: AbortSignal;
}): Promise<"dispatched" | "duplicate" | { readonly kind: "run_error" }> {
  const processedId = await insertGmailProcessedEvent(args);
  if (!processedId) {
    return "duplicate";
  }

  const automation = gmailRowToAutomation({
    id: args.trigger.automationId,
    agentId: args.trigger.agentId,
    orgId: args.trigger.orgId,
    userId: args.trigger.userId,
    chatThreadId: args.trigger.chatThreadId,
    instruction: args.trigger.instruction,
    appendSystemPrompt: args.trigger.appendSystemPrompt,
  });
  const runInput = await new DefaultInterpreter().interpret(
    automation,
    buildGmailTriggerEvent(args),
  );
  args.signal.throwIfAborted();

  const result = await args.startRun({
    trigger: args.trigger,
    runInput,
  });
  args.signal.throwIfAborted();
  if (result.kind !== "ok") {
    await args.db
      .delete(gmailProcessedEvents)
      .where(eq(gmailProcessedEvents.id, processedId));
    args.signal.throwIfAborted();
    return { kind: "run_error" };
  }

  await postAutomationUserMessage({
    db: args.db,
    threadId: runInput.chatThreadId,
    userId: args.trigger.userId,
    runId: result.runId,
    prompt: runInput.prompt,
    appendQueueMarker: result.status === "queued",
    automationTitle: args.trigger.name,
    automationSnapshot: {
      id: args.trigger.automationId,
      title: args.trigger.name,
      description: args.trigger.description,
    },
  });
  args.signal.throwIfAborted();

  await args.db
    .update(automationTriggers)
    .set({ lastRunId: result.runId, updatedAt: nowDate() })
    .where(eq(automationTriggers.id, args.trigger.triggerId));
  args.signal.throwIfAborted();

  return "dispatched";
}

async function dispatchGmailHistoryEvent(args: {
  readonly db: Db;
  readonly state: GmailWatchStateRow;
  readonly decoded: DecodedGmailPubSubPush;
  readonly accessToken: string;
  readonly triggers: readonly ParsedGmailEventTriggerRow[];
  readonly event: GmailHistoryMessageAdded;
  readonly messageCache: Map<string, GmailMessageContext | null>;
  readonly startRun: GmailRunStarter;
  readonly signal: AbortSignal;
}): Promise<GmailDispatchStateResult> {
  const message = await cachedGmailMessageContext({
    cache: args.messageCache,
    accessToken: args.accessToken,
    event: args.event,
    signal: args.signal,
  });
  if (!message || !messageIsInbound(message)) {
    return { kind: "ok", dispatched: 0, duplicates: 0 };
  }

  const matchingTriggers = args.triggers.filter((trigger) => {
    return gmailMessageMatchesConfig(message, trigger.config);
  });
  if (matchingTriggers.length === 0) {
    return { kind: "ok", dispatched: 0, duplicates: 0 };
  }

  let dispatched = 0;
  let duplicates = 0;

  for (const trigger of matchingTriggers) {
    const result = await dispatchGmailTriggerEvent({
      db: args.db,
      state: args.state,
      trigger,
      decoded: args.decoded,
      event: args.event,
      message,
      startRun: args.startRun,
      signal: args.signal,
    });
    if (typeof result !== "string") {
      return {
        kind: "run_error",
        message: "Failed to start Gmail event automation run",
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
  readonly triggers: readonly ParsedGmailEventTriggerRow[];
  readonly startRun: GmailRunStarter;
  readonly signal: AbortSignal;
}): Promise<GmailDispatchStateResult> {
  const messageCache = new Map<string, GmailMessageContext | null>();
  let dispatched = 0;
  let duplicates = 0;

  for (const event of args.history.messagesAdded) {
    const result = await dispatchGmailHistoryEvent({
      db: args.db,
      state: args.state,
      decoded: args.decoded,
      accessToken: args.accessToken,
      triggers: args.triggers,
      event,
      messageCache,
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
  readonly startRun: GmailRunStarter;
  readonly signal: AbortSignal;
}): Promise<GmailDispatchStateResult> {
  const gateEnabled = await args.isFeatureEnabledForOwner(
    args.state.orgId,
    args.state.userId,
  );
  args.signal.throwIfAborted();
  if (!gateEnabled) {
    return { kind: "ok", dispatched: 0, duplicates: 0 };
  }

  const access = await resolveGmailAccess({
    db: args.db,
    orgId: args.state.orgId,
    userId: args.state.userId,
    connectorId: args.state.connectorId,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  if (access.kind !== "ok") {
    log.warn("Gmail event skipped because connector access is unavailable", {
      watchStateId: args.state.id,
      message: access.message,
    });
    return { kind: "ok", dispatched: 0, duplicates: 0 };
  }

  const history = await listGmailMessageHistory({
    accessToken: access.access.accessToken,
    startHistoryId: args.state.lastHistoryId,
    signal: args.signal,
  });
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

  const triggers = await loadGmailEventTriggers(args);
  const result = await dispatchGmailHistoryEvents({
    db: args.db,
    state: args.state,
    decoded: args.decoded,
    accessToken: access.access.accessToken,
    history,
    triggers,
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

    const db = set(writeDb$);
    const states = await loadGmailWatchStates({
      db,
      decoded,
      topicName,
      signal,
    });
    const isFeatureEnabledForOwner: GmailFeatureGateChecker = async (
      orgId,
      userId,
    ) => {
      return await get(gmailEventTriggersEnabledForOwner(orgId, userId));
    };
    const startRun: GmailRunStarter = async ({ trigger, runInput }) => {
      const result = await set(
        createZeroRun$,
        {
          auth: {
            orgId: trigger.orgId,
            orgRole: "member",
            userId: trigger.userId,
            tokenType: "session",
          },
          body: {
            prompt: runInput.prompt,
            agentId: runInput.agentId,
          },
          apiStartTime: args.apiStartTime,
          triggerSource: "gmail",
          chatThreadId: runInput.chatThreadId,
          appendSystemPrompt: runInput.appendSystemPrompt,
          callbacks: runInput.callbacks,
          zeroRunMetadata: runInput.zeroRunMetadata,
        },
        signal,
      );
      signal.throwIfAborted();

      return result.status === 201
        ? {
            kind: "ok",
            runId: result.body.runId,
            status: result.body.status,
          }
        : { kind: "error" };
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
