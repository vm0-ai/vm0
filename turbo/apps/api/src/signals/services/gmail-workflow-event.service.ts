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
import {
  gmailProcessedEvents,
  gmailWatchStates,
} from "@vm0/db/schema/gmail-event";
import {
  workflowUserAutomationThreads,
  zeroWorkflowAutomations,
  zeroWorkflows,
} from "@vm0/db/schema/zero-workflow";

import { optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { testOverride } from "../../lib/singleton";
import { writeDb$, type Db } from "../external/db";
import { now, nowDate } from "../external/time";
import { safeJsonParse, tapError } from "../utils";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import { loadConnectorRuntimeSnapshot } from "./connector-catalog-runtime.service";
import {
  connectorCredentialRuntimeValueRef,
  loadConnectorCredentialConnection,
  loadConnectorCredentialValues,
  refreshConnectorCredentialAccess,
} from "./connector-credential-runtime.service";
import {
  WorkflowEventSourceTiming,
  type WorkflowEventRunTiming,
} from "./workflow-event-source-timing.service";
import {
  buildChatOnlyWorkflowAutomationCallbacks,
  runWorkflowAutomationNow$,
  type AutomationRow,
} from "./zero-workflow-automation-run.service";
import {
  workflowAutomationAppendSystemPrompt,
  workflowAutomationPrompt,
  type WorkflowAutomationContext,
} from "./workflow-automation-context.service";
import { workflowAutomationCanFire } from "./zero-workflow-automation-access.service";
import { ensureWorkflowUserAutomationThread } from "./zero-workflow-user-automation-thread.service";

const log = logger("api:gmail-workflow-event");

const GMAIL_ACCESS_TOKEN_ENVIRONMENT_NAME = "GMAIL_TOKEN";
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

async function resolveGmailAccess(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId?: string;
  readonly signal: AbortSignal;
}): Promise<GmailAccessResult> {
  const currentTime = nowDate();
  const snapshot = await loadConnectorRuntimeSnapshot(args.db);
  args.signal.throwIfAborted();
  const loaded = await loadConnectorCredentialConnection({
    db: args.db,
    snapshot,
    orgId: args.orgId,
    userId: args.userId,
    connectorSlug: "gmail",
    ...(args.connectorId === undefined
      ? {}
      : { connectorId: args.connectorId }),
  });
  args.signal.throwIfAborted();
  if (loaded.kind === "missing") {
    return {
      kind: "bad_request",
      message: "Connect Gmail before adding a Gmail event automation",
    };
  }
  if (loaded.kind === "unavailable" || loaded.connection.needsReconnect) {
    return {
      kind: "bad_request",
      message: "Reconnect Gmail before using Gmail event automations",
    };
  }
  const connection = loaded.connection;
  const accessTokenValueRef = connectorCredentialRuntimeValueRef(
    connection,
    GMAIL_ACCESS_TOKEN_ENVIRONMENT_NAME,
  );
  if (accessTokenValueRef === null) {
    return {
      kind: "bad_request",
      message: "Reconnect Gmail before using Gmail event automations",
    };
  }
  const values = await loadConnectorCredentialValues({
    connection,
    db: args.db,
    valueRefs: [accessTokenValueRef],
  });
  args.signal.throwIfAborted();
  const accessToken = values.get(accessTokenValueRef);
  if (!accessToken) {
    return {
      kind: "bad_request",
      message: "Reconnect Gmail before using Gmail event automations",
    };
  }
  if (!tokenNeedsRefresh(connection.tokenExpiresAt, currentTime)) {
    return {
      kind: "ok",
      access: {
        connectorId: connection.connectorId,
        emailAddress: connection.externalEmail,
        accessToken,
      },
    };
  }
  const refreshed = await refreshConnectorCredentialAccess({
    connection,
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    runtimeEnvironmentName: GMAIL_ACCESS_TOKEN_ENVIRONMENT_NAME,
    signal: args.signal,
    persist: { db: args.db, markNeedsReconnectOnFailure: true },
  });
  if (refreshed.kind === "configuration-unavailable") {
    return {
      kind: "bad_request",
      message: "Google OAuth client env vars are not configured",
    };
  }
  if (refreshed.kind !== "ok") {
    return {
      kind: "bad_request",
      message: "Reconnect Gmail before using Gmail event automations",
    };
  }
  return {
    kind: "ok",
    access: {
      connectorId: connection.connectorId,
      emailAddress: connection.externalEmail,
      accessToken: refreshed.accessToken,
    },
  };
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
        message: "Failed to read Gmail profile for event automation setup",
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
      message: "Failed to register Gmail watch for event automation setup",
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
  if (config.threadId && message.threadId !== config.threadId) {
    return false;
  }
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
  const claims = await tapError(verifier(token, audience, args.signal));
  args.signal.throwIfAborted();
  if (!claims) {
    return { kind: "unauthorized" };
  }

  return claims.email === expectedEmail && claims.emailVerified
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

interface GmailEventAutomationRow {
  readonly automation: AutomationRow;
  readonly agentId: string;
  readonly workflowName: string;
  readonly chatThreadId: string;
  readonly config: GmailWorkflowEventConfig;
}

type GmailRunStarter = (args: {
  readonly automation: GmailEventAutomationRow;
  readonly decoded: DecodedGmailPubSubPush;
  readonly message: GmailMessageContext;
  readonly timing: WorkflowEventRunTiming;
}) => Promise<"ok" | "error">;

interface GmailWorkflowRunStartTestInput {
  readonly automationId: string;
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

async function loadGmailEventAutomations(args: {
  readonly db: Db;
  readonly state: GmailWatchStateRow;
  readonly signal: AbortSignal;
}): Promise<GmailEventAutomationRow[]> {
  const automationRows = await args.db
    .select({
      automation: zeroWorkflowAutomations,
      agentId: zeroWorkflows.agentId,
      workflowName: zeroWorkflows.name,
      workflowDisplayName: zeroWorkflows.displayName,
      chatThreadId: workflowUserAutomationThreads.chatThreadId,
    })
    .from(zeroWorkflowAutomations)
    .innerJoin(
      zeroWorkflows,
      eq(zeroWorkflowAutomations.workflowId, zeroWorkflows.id),
    )
    .leftJoin(
      workflowUserAutomationThreads,
      and(
        eq(workflowUserAutomationThreads.orgId, zeroWorkflowAutomations.orgId),
        eq(
          workflowUserAutomationThreads.userId,
          zeroWorkflowAutomations.ownerUserId,
        ),
        eq(
          workflowUserAutomationThreads.workflowId,
          zeroWorkflowAutomations.workflowId,
        ),
      ),
    )
    .where(
      and(
        eq(zeroWorkflowAutomations.orgId, args.state.orgId),
        eq(zeroWorkflowAutomations.ownerUserId, args.state.userId),
        eq(zeroWorkflowAutomations.enabled, true),
        eq(zeroWorkflowAutomations.kind, "event"),
        inArray(zeroWorkflowAutomations.eventType, [
          "gmail-new-message",
          "gmail-label-applied",
        ]),
      ),
    );
  args.signal.throwIfAborted();

  const currentTime = nowDate();
  const automations: GmailEventAutomationRow[] = [];
  for (const row of automationRows) {
    const config =
      row.automation.eventType === "gmail-label-applied"
        ? gmailLabelAppliedEventConfigSchema.safeParse(
            row.automation.eventConfig,
          )
        : gmailNewMessageEventConfigSchema.safeParse(
            row.automation.eventConfig,
          );
    if (!config.success) {
      continue;
    }
    const canFire = await workflowAutomationCanFire(args.db, {
      automation: row.automation,
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
        return await ensureWorkflowUserAutomationThread(tx, {
          orgId: row.automation.orgId,
          userId: row.automation.ownerUserId,
          workflowId: row.automation.workflowId,
          agentId: row.agentId,
          workflowTitle: row.workflowDisplayName ?? row.workflowName,
          currentTime,
        });
      }));
    args.signal.throwIfAborted();
    automations.push({
      automation: row.automation,
      agentId: row.agentId,
      workflowName: row.workflowName,
      chatThreadId,
      config: config.data,
    });
  }
  return automations;
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
  readonly automation: GmailEventAutomationRow;
  readonly decoded: DecodedGmailPubSubPush;
  readonly event: GmailHistoryMessageEvent;
  readonly message: GmailMessageContext;
  readonly signal: AbortSignal;
}): Promise<string | null> {
  const [processed] = await args.db
    .insert(gmailProcessedEvents)
    .values({
      watchStateId: args.state.id,
      automationId: args.automation.automation.id,
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

function gmailTriggerContext(args: {
  readonly workflowName: string;
  readonly automationId: string;
  readonly automationConfig: GmailWorkflowEventConfig;
  readonly emailAddress: string;
  readonly message: GmailMessageContext;
}): WorkflowAutomationContext {
  const matched =
    args.automationConfig.event === "label_applied"
      ? `Gmail label "${args.automationConfig.labelName}" was applied to a message`
      : "a new inbound Gmail message arrived";
  return {
    workflowName: args.workflowName,
    eventType:
      args.automationConfig.event === "label_applied"
        ? "gmail-label-applied"
        : "gmail-new-message",
    trigger: `${matched} on ${args.emailAddress} (Gmail message ${args.message.messageId}).`,
    notes: [
      "Not included below: the email body. Connected Gmail tools return the message and thread content.",
      "Sending is a user action. This automation prepares drafts; the user sends them.",
    ],
    event: {
      automationId: args.automationId,
      event: args.automationConfig.event,
      labelName:
        args.automationConfig.event === "label_applied"
          ? args.automationConfig.labelName
          : undefined,
      emailAddress: args.emailAddress,
      messageId: args.message.messageId,
      threadId: args.message.threadId,
      from: args.message.from,
      to: args.message.to,
      cc: args.message.cc,
      subject: args.message.subject,
    },
  };
}

function buildGmailWorkflowAutomationBrief(args: {
  readonly automationConfig: GmailWorkflowEventConfig;
  readonly message: {
    readonly messageId: string;
    readonly threadId: string | null;
    readonly from: string | null;
    readonly subject: string | null;
  };
}): string {
  const title =
    args.automationConfig.event === "label_applied"
      ? `Gmail label applied: ${args.automationConfig.labelName}`
      : "Gmail new message";
  return [
    title,
    `From: ${args.message.from?.trim() || "Unknown sender"}`,
    `Subject: ${args.message.subject?.trim() || "(no subject)"}`,
  ].join("\n");
}

async function dispatchGmailAutomationEvent(args: {
  readonly db: Db;
  readonly state: GmailWatchStateRow;
  readonly automation: GmailEventAutomationRow;
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
    automation: args.automation,
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

function isGmailNewMessageAutomation(
  automation: GmailEventAutomationRow,
): automation is GmailEventAutomationRow & {
  readonly config: GmailNewMessageEventConfig;
} {
  return automation.config.event === "new_message";
}

function isGmailLabelAppliedAutomation(
  automation: GmailEventAutomationRow,
): automation is GmailEventAutomationRow & {
  readonly config: GmailLabelAppliedEventConfig;
} {
  return automation.config.event === "label_applied";
}

async function updateResolvedGmailLabelId(args: {
  readonly db: Db;
  readonly automation: GmailEventAutomationRow & {
    readonly config: GmailLabelAppliedEventConfig;
  };
  readonly labelId: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (args.automation.config.resolvedLabelId === args.labelId) {
    return;
  }

  await args.db
    .update(zeroWorkflowAutomations)
    .set({
      eventConfig: {
        ...args.automation.config,
        resolvedLabelId: args.labelId,
      },
      updatedAt: nowDate(),
    })
    .where(eq(zeroWorkflowAutomations.id, args.automation.automation.id));
  args.signal.throwIfAborted();
}

async function labelAppliedAutomationMatchesEvent(args: {
  readonly db: Db;
  readonly accessToken: string;
  readonly automation: GmailEventAutomationRow & {
    readonly config: GmailLabelAppliedEventConfig;
  };
  readonly event: GmailHistoryLabelAdded;
  readonly labelCache: Map<string, GmailLabelResolveResult>;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  const eventLabelIds = new Set(args.event.labelIds);
  const resolvedLabelId = args.automation.config.resolvedLabelId;
  if (resolvedLabelId && eventLabelIds.has(resolvedLabelId)) {
    return true;
  }

  const labelName = args.automation.config.labelName;
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
      automationId: args.automation.automation.id,
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
    automation: args.automation,
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
  readonly automations: readonly GmailEventAutomationRow[];
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

  let dispatched = 0;
  let duplicates = 0;

  for (const automation of args.automations) {
    const runTiming = args.sourceTiming.createRunTiming();
    const matches = await runTiming.measure(
      "api_dispatch_pre_create_zero_workflow_event_match_automations",
      () => {
        return (
          isGmailNewMessageAutomation(automation) &&
          gmailMessageMatchesConfig(message, automation.config)
        );
      },
    );
    if (!matches) {
      continue;
    }
    const result = await dispatchGmailAutomationEvent({
      db: args.db,
      state: args.state,
      automation,
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
  readonly automations: readonly GmailEventAutomationRow[];
  readonly event: GmailHistoryLabelAdded;
  readonly messageCache: Map<string, GmailMessageContext | null>;
  readonly labelCache: Map<string, GmailLabelResolveResult>;
  readonly sourceTiming: WorkflowEventSourceTiming;
  readonly startRun: GmailRunStarter;
  readonly signal: AbortSignal;
}): Promise<GmailDispatchStateResult> {
  const labelAutomations = args.automations.filter(
    isGmailLabelAppliedAutomation,
  );
  if (labelAutomations.length === 0 || args.event.labelIds.length === 0) {
    return { kind: "ok", dispatched: 0, duplicates: 0 };
  }

  const matchingAutomations: {
    readonly automation: (typeof labelAutomations)[number];
    readonly timing: WorkflowEventRunTiming;
  }[] = [];
  for (const automation of labelAutomations) {
    const runTiming = args.sourceTiming.createRunTiming();
    const matches = await runTiming.measure(
      "api_dispatch_pre_create_zero_workflow_event_match_automations",
      async () => {
        return await labelAppliedAutomationMatchesEvent({
          db: args.db,
          accessToken: args.accessToken,
          automation,
          event: args.event,
          labelCache: args.labelCache,
          signal: args.signal,
        });
      },
    );
    if (matches) {
      matchingAutomations.push({ automation, timing: runTiming });
    }
  }
  if (matchingAutomations.length === 0) {
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

  for (const match of matchingAutomations) {
    match.timing.recordElapsed(
      "api_dispatch_pre_create_zero_workflow_event_load_external_events",
      messageStartedAt,
      messageFinishedAt,
    );
    const result = await dispatchGmailAutomationEvent({
      db: args.db,
      state: args.state,
      automation: match.automation,
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
  readonly automations: readonly GmailEventAutomationRow[];
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
      automations: args.automations,
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
      automations: args.automations,
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
  readonly sourceTiming: WorkflowEventSourceTiming;
  readonly startRun: GmailRunStarter;
  readonly signal: AbortSignal;
}): Promise<GmailDispatchStateResult> {
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

  const automations = await args.sourceTiming.measure(
    "api_dispatch_pre_create_zero_workflow_event_load_automations",
    async () => {
      return await loadGmailEventAutomations(args);
    },
  );
  const result = await dispatchGmailHistoryEvents({
    db: args.db,
    state: args.state,
    decoded: args.decoded,
    accessToken: access.access.accessToken,
    history,
    automations,
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
      readonly automation: GmailEventAutomationRow;
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
        const context = gmailTriggerContext({
          workflowName: args.automation.workflowName,
          automationId: args.automation.automation.id,
          automationConfig: args.automation.config,
          emailAddress: args.decoded.emailAddress,
          message: args.message,
        });
        return {
          context,
          prompt: workflowAutomationPrompt(context),
          appendSystemPrompt: workflowAutomationAppendSystemPrompt(context),
          triggerBrief: buildGmailWorkflowAutomationBrief({
            automationConfig: args.automation.config,
            message: args.message,
          }),
          callbacks: buildChatOnlyWorkflowAutomationCallbacks(
            args.automation.chatThreadId,
            args.automation.agentId,
          ),
        };
      },
    );
    signal.throwIfAborted();
    const result = await set(
      runWorkflowAutomationNow$,
      {
        due: {
          automation: args.automation.automation,
          agentId: args.automation.agentId,
          workflowName: args.automation.workflowName,
          chatThreadId: args.automation.chatThreadId,
        },
        automationContext: runInput.context,
        apiStartTime: args.apiStartTime,
        triggerSource: "workflow-event",
        prompt: runInput.prompt,
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
    return result.kind === "ok" || result.kind === "enqueued" ? "ok" : "error";
  },
);

export const dispatchGmailPubSubPush$ = command(
  async (
    { set },
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
    const runStarterOverride = gmailRunStarterOverride.get();
    const startRun: GmailRunStarter = runStarterOverride
      ? async ({ automation, decoded, message }) => {
          return await runStarterOverride({
            automationId: automation.automation.id,
            workflowName: automation.workflowName,
            emailAddress: decoded.emailAddress,
            messageId: message.messageId,
            threadId: message.threadId,
            subject: message.subject,
            triggerBrief: buildGmailWorkflowAutomationBrief({
              automationConfig: automation.config,
              message,
            }),
          });
        }
      : async ({ automation, decoded, message, timing }) => {
          return await set(
            startGmailWorkflowRun$,
            {
              automation,
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
