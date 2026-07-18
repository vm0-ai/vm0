import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  zeroMailDraftSchema,
  zeroMailLegacyDraftSchema,
  type ZeroMailDraft,
  type ZeroMailDraftResourceStatus,
  type ZeroMailLegacyDraft,
  type ZeroMailProvider,
} from "@vm0/api-contracts/contracts/zero-mail";
import { refreshGoogleToken } from "@vm0/connectors/auth-providers/oauth/google";
import { hasRequiredConnectorAuthMethodScopes } from "@vm0/connectors/connector-utils";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { connectors } from "@vm0/db/schema/connector";
import { mailDrafts } from "@vm0/db/schema/mail-draft";
import { secrets } from "@vm0/db/schema/secret";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { z } from "zod";

import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { db$, writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { nowDate } from "../external/time";
import { settleIncludingAbort, tapError } from "../utils";
import { lockConnectorState } from "./auth-state-lock.service";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "./crypto.utils";
import { insertChatMessage } from "./zero-chat-message.service";

const L = logger("api:zero-mail");

const TOKEN_REFRESH_SKEW_MS = 60_000;
const DEFAULT_ACCESS_TOKEN_EXPIRES_IN_MS = 60 * 60 * 1000;
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const GMAIL_ACCESS_TOKEN_SECRET = "GMAIL_ACCESS_TOKEN";
const GMAIL_REFRESH_TOKEN_SECRET = "GMAIL_REFRESH_TOKEN";
const oauthScopesSchema = z.array(z.string());

const gmailDraftResourceSchema = z.object({
  id: z.string(),
  message: z.object({
    id: z.string(),
    threadId: z.string(),
    raw: z.string().optional(),
  }),
});

const gmailMessageResourceSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  raw: z.string().optional(),
});

interface MailConnection {
  readonly connectorId: string;
  readonly externalEmail: string;
  readonly externalUsername: string | null;
  readonly needsReconnect: boolean;
  readonly scopesReady: boolean;
  readonly tokenExpiresAt: Date | null;
}

interface MailDraftResult {
  readonly kind: "ok";
  readonly mailDraftId: string;
  readonly mailDraftUrl: string;
  readonly mailDraft: ZeroMailDraft;
}

interface MailDraftErrorResult {
  readonly kind: "not_found" | "conflict";
  readonly message: string;
}

export type ZeroMailDraftMutationResult =
  | MailDraftResult
  | MailDraftErrorResult;

interface NewMailDraftRow {
  readonly kind: "gmail";
  readonly id: string;
  readonly agentId: string;
  readonly chatThreadId: string;
  readonly connectorId: string | null;
  readonly gmailDraftId: string | null;
  readonly gmailThreadId: string | null;
  readonly gmailMessageId: string | null;
  readonly sentGmailMessageId: string | null;
  readonly status: ZeroMailDraftResourceStatus;
  readonly senderName: string | null;
  readonly senderAddress: string;
  readonly subject: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly sentAt: Date | null;
}

interface LegacyMailDraftRow {
  readonly kind: "legacy";
  readonly id: string;
  readonly agentId: string;
  readonly chatThreadId: string;
  readonly draft: ZeroMailLegacyDraft;
}

type StoredMailDraftRow = NewMailDraftRow | LegacyMailDraftRow;

interface MailAccessTokenSuccess {
  readonly kind: "ok";
  readonly accessToken: string;
}

interface MailAccessTokenFailure {
  readonly kind: "error";
  readonly message: string;
}

type MailAccessTokenResult = MailAccessTokenSuccess | MailAccessTokenFailure;

interface MailDetails {
  readonly from: string;
  readonly fromName?: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly replyTo?: string;
  readonly inReplyTo?: string;
  readonly references: readonly string[];
}

interface GmailDraftValue {
  readonly draftId: string;
  readonly messageId: string;
  readonly threadId: string;
  readonly details: MailDetails;
}

interface GmailSentValue {
  readonly messageId: string;
  readonly threadId: string;
  readonly details: MailDetails | null;
}

function mailDraftUrl(mailDraftId: string): string {
  return `${env("APP_URL").replace(/\/+$/u, "")}/mail/drafts/${mailDraftId}`;
}

function okResult(
  mailDraftId: string,
  mailDraft: ZeroMailDraft,
): MailDraftResult {
  return {
    kind: "ok",
    mailDraftId,
    mailDraftUrl: mailDraftUrl(mailDraftId),
    mailDraft,
  };
}

async function loadMailConnections(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
}): Promise<readonly MailConnection[]> {
  const rows = await args.db
    .select({
      connectorId: connectors.id,
      authMethod: connectors.authMethod,
      externalEmail: connectors.externalEmail,
      externalUsername: connectors.externalUsername,
      needsReconnect: connectors.needsReconnect,
      oauthScopes: connectors.oauthScopes,
      tokenExpiresAt: connectors.tokenExpiresAt,
    })
    .from(userConnectors)
    .innerJoin(
      connectors,
      and(
        eq(connectors.orgId, userConnectors.orgId),
        eq(connectors.userId, userConnectors.userId),
        eq(connectors.type, userConnectors.connectorType),
      ),
    )
    .where(
      and(
        eq(userConnectors.orgId, args.orgId),
        eq(userConnectors.userId, args.userId),
        eq(userConnectors.agentId, args.agentId),
        eq(userConnectors.connectorType, "gmail"),
      ),
    );

  return rows.flatMap((row): MailConnection[] => {
    if (!row.externalEmail) {
      return [];
    }
    return [
      {
        connectorId: row.connectorId,
        externalEmail: row.externalEmail,
        externalUsername: row.externalUsername,
        needsReconnect: row.needsReconnect,
        scopesReady: hasRequiredConnectorAuthMethodScopes(
          "gmail",
          row.authMethod,
          row.oauthScopes
            ? oauthScopesSchema.parse(JSON.parse(row.oauthScopes))
            : null,
        ),
        tokenExpiresAt: row.tokenExpiresAt,
      },
    ];
  });
}

async function ownedThreadAgentId(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
  readonly threadId: string;
}): Promise<string | null> {
  const [row] = await args.db
    .select({ agentId: chatThreads.agentComposeId })
    .from(chatThreads)
    .innerJoin(agentComposes, eq(agentComposes.id, chatThreads.agentComposeId))
    .where(
      and(
        eq(chatThreads.id, args.threadId),
        eq(chatThreads.userId, args.userId),
        eq(agentComposes.orgId, args.orgId),
      ),
    )
    .limit(1);
  return row?.agentId ?? null;
}

async function loadOwnedNewMailDraft(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
  readonly mailDraftId: string;
}): Promise<NewMailDraftRow | null> {
  const [row] = await args.db
    .select({
      id: mailDrafts.id,
      agentId: chatThreads.agentComposeId,
      chatThreadId: chatThreads.id,
      connectorId: mailDrafts.connectorId,
      gmailDraftId: mailDrafts.gmailDraftId,
      gmailThreadId: mailDrafts.gmailThreadId,
      gmailMessageId: mailDrafts.gmailMessageId,
      sentGmailMessageId: mailDrafts.sentGmailMessageId,
      status: mailDrafts.status,
      senderName: mailDrafts.senderName,
      senderAddress: mailDrafts.senderAddress,
      subject: mailDrafts.subject,
      createdAt: mailDrafts.createdAt,
      updatedAt: mailDrafts.updatedAt,
      sentAt: mailDrafts.sentAt,
    })
    .from(mailDrafts)
    .innerJoin(chatThreads, eq(chatThreads.id, mailDrafts.chatThreadId))
    .innerJoin(agentComposes, eq(agentComposes.id, chatThreads.agentComposeId))
    .where(
      and(
        eq(mailDrafts.id, args.mailDraftId),
        eq(chatThreads.userId, args.userId),
        eq(agentComposes.orgId, args.orgId),
      ),
    )
    .limit(1);
  if (!row?.status || !row.senderAddress || row.subject === null) {
    return null;
  }
  return {
    kind: "gmail",
    ...row,
    status: row.status,
    senderAddress: row.senderAddress,
    subject: row.subject,
  };
}

async function loadOwnedLegacyMailDraft(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
  readonly mailDraftId: string;
}): Promise<LegacyMailDraftRow | null> {
  const [row] = await args.db
    .select({
      id: mailDrafts.id,
      agentId: chatThreads.agentComposeId,
      chatThreadId: chatThreads.id,
      draft: mailDrafts.draft,
    })
    .from(mailDrafts)
    .innerJoin(chatThreads, eq(chatThreads.id, mailDrafts.chatThreadId))
    .innerJoin(agentComposes, eq(agentComposes.id, chatThreads.agentComposeId))
    .where(
      and(
        eq(mailDrafts.id, args.mailDraftId),
        eq(chatThreads.userId, args.userId),
        eq(agentComposes.orgId, args.orgId),
      ),
    )
    .limit(1);
  if (!row?.draft) {
    return null;
  }
  return {
    kind: "legacy",
    id: row.id,
    agentId: row.agentId,
    chatThreadId: row.chatThreadId,
    draft: zeroMailLegacyDraftSchema.parse(row.draft),
  };
}

async function loadOwnedMailDraft(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
  readonly mailDraftId: string;
}): Promise<StoredMailDraftRow | null> {
  return (
    (await loadOwnedNewMailDraft(args)) ??
    (await loadOwnedLegacyMailDraft(args))
  );
}

async function upsertConnectorSecret(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly value: string;
}): Promise<void> {
  const encryptedValue = await encryptStoredSecretValue(args.value);
  await args.db
    .insert(secrets)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      name: args.name,
      encryptedValue,
      description: null,
      type: "connector",
    })
    .onConflictDoUpdate({
      target: [secrets.orgId, secrets.userId, secrets.name, secrets.type],
      set: {
        encryptedValue,
        description: null,
        updatedAt: sql`clock_timestamp()`,
      },
    });
}

async function loadConnectorTokens(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
}): Promise<{
  readonly accessToken: string | null;
  readonly refreshToken: string | null;
}> {
  const rows = await args.db
    .select({ name: secrets.name, encryptedValue: secrets.encryptedValue })
    .from(secrets)
    .where(
      and(
        eq(secrets.orgId, args.orgId),
        eq(secrets.userId, args.userId),
        eq(secrets.type, "connector"),
        inArray(secrets.name, [
          GMAIL_ACCESS_TOKEN_SECRET,
          GMAIL_REFRESH_TOKEN_SECRET,
        ]),
      ),
    );
  const values = new Map<string, string>();
  for (const row of rows) {
    values.set(row.name, await decryptStoredSecretValue(row.encryptedValue));
  }
  return {
    accessToken: values.get(GMAIL_ACCESS_TOKEN_SECRET) ?? null,
    refreshToken: values.get(GMAIL_REFRESH_TOKEN_SECRET) ?? null,
  };
}

async function refreshMailAccessToken(args: {
  readonly connection: MailConnection;
  readonly orgId: string;
  readonly userId: string;
  readonly refreshToken: string;
  readonly signal: AbortSignal;
  readonly writeDb: Db;
}): Promise<MailAccessTokenResult> {
  const clientId = optionalEnv("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = optionalEnv("GOOGLE_OAUTH_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return { kind: "error", message: "Gmail OAuth is not configured" };
  }

  const refreshResult = await settleIncludingAbort(
    refreshGoogleToken(
      "gmail",
      clientId,
      clientSecret,
      args.refreshToken,
      args.signal,
    ),
  );
  if (!refreshResult.ok) {
    L.warn("Gmail access token refresh failed", {
      connectorId: args.connection.connectorId,
      error: refreshResult.error,
    });
    return { kind: "error", message: "Reconnect Gmail before continuing" };
  }
  const refreshed = refreshResult.value;
  const nextRefreshToken = refreshed.refreshToken ?? args.refreshToken;
  const tokenExpiresAt = new Date(
    nowDate().getTime() +
      (refreshed.expiresIn
        ? refreshed.expiresIn * 1000
        : DEFAULT_ACCESS_TOKEN_EXPIRES_IN_MS),
  );
  await args.writeDb.transaction(async (tx) => {
    await lockConnectorState(tx, {
      orgId: args.orgId,
      userId: args.userId,
      type: "gmail",
    });
    await upsertConnectorSecret({
      db: tx,
      orgId: args.orgId,
      userId: args.userId,
      name: GMAIL_ACCESS_TOKEN_SECRET,
      value: refreshed.accessToken,
    });
    await upsertConnectorSecret({
      db: tx,
      orgId: args.orgId,
      userId: args.userId,
      name: GMAIL_REFRESH_TOKEN_SECRET,
      value: nextRefreshToken,
    });
    await tx
      .update(connectors)
      .set({
        tokenExpiresAt,
        needsReconnect: false,
        reconnectReason: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(connectors.id, args.connection.connectorId));
  });
  return { kind: "ok", accessToken: refreshed.accessToken };
}

async function resolveMailAccessToken(args: {
  readonly connection: MailConnection;
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
  readonly signal: AbortSignal;
  readonly writeDb: Db;
}): Promise<MailAccessTokenResult> {
  if (args.connection.needsReconnect || !args.connection.scopesReady) {
    return { kind: "error", message: "Reconnect Gmail before continuing" };
  }
  const tokens = await loadConnectorTokens(args);
  const expiresAt = args.connection.tokenExpiresAt?.getTime() ?? 0;
  if (
    tokens.accessToken &&
    (expiresAt === 0 || expiresAt > nowDate().getTime() + TOKEN_REFRESH_SKEW_MS)
  ) {
    return { kind: "ok", accessToken: tokens.accessToken };
  }
  if (!tokens.refreshToken) {
    return { kind: "error", message: "Reconnect Gmail before continuing" };
  }
  return await refreshMailAccessToken({
    connection: args.connection,
    orgId: args.orgId,
    userId: args.userId,
    refreshToken: tokens.refreshToken,
    signal: args.signal,
    writeDb: args.writeDb,
  });
}

function encodeHeader(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function gmailRawMessage(details: MailDetails): string {
  const encodedBody = Buffer.from(details.body, "utf8")
    .toString("base64")
    .match(/.{1,76}/gu)
    ?.join("\r\n");
  const headers = [
    details.fromName
      ? `From: ${encodeHeader(details.fromName)} <${details.from}>`
      : `From: ${details.from}`,
    `To: ${details.to.join(", ")}`,
    ...(details.cc.length > 0 ? [`Cc: ${details.cc.join(", ")}`] : []),
    ...(details.bcc.length > 0 ? [`Bcc: ${details.bcc.join(", ")}`] : []),
    ...(details.replyTo ? [`Reply-To: ${details.replyTo}`] : []),
    ...(details.inReplyTo ? [`In-Reply-To: ${details.inReplyTo}`] : []),
    ...(details.references.length > 0
      ? [`References: ${details.references.join(" ")}`]
      : []),
    `Subject: ${encodeHeader(details.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  const mime = [...headers, "", encodedBody ?? ""].join("\r\n");
  return Buffer.from(mime, "utf8").toString("base64url");
}

function decodeHeader(value: string): string {
  return value.replace(
    /=\?UTF-8\?B\?([^?]+)\?=/giu,
    (_match, encoded: string) => {
      return Buffer.from(encoded, "base64").toString("utf8");
    },
  );
}

function parseAddressList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value.split(",").flatMap((part): string[] => {
    const candidate = part.trim();
    const angle = candidate.match(/<([^>]+)>/u)?.[1];
    const address = (angle ?? candidate).trim();
    return z.email().safeParse(address).success ? [address] : [];
  });
}

function parseFromHeader(value: string | undefined): {
  readonly address: string;
  readonly name?: string;
} {
  const decoded = decodeHeader(value ?? "").trim();
  const match = decoded.match(/^(.*?)\s*<([^>]+)>$/u);
  if (match?.[2] && z.email().safeParse(match[2]).success) {
    const name = match[1]?.trim().replace(/^"|"$/gu, "");
    return name ? { address: match[2], name } : { address: match[2] };
  }
  if (!z.email().safeParse(decoded).success) {
    throw new Error("Gmail draft has an invalid From header");
  }
  return { address: decoded };
}

function parseRawMail(raw: string): MailDetails {
  const mime = Buffer.from(raw, "base64url").toString("utf8");
  const separator = mime.search(/\r?\n\r?\n/u);
  const headerText = separator === -1 ? mime : mime.slice(0, separator);
  const bodyText =
    separator === -1 ? "" : mime.slice(separator).replace(/^\r?\n\r?\n/u, "");
  const unfolded = headerText.replace(/\r?\n[ \t]+/gu, " ");
  const headers = new Map<string, string>();
  for (const line of unfolded.split(/\r?\n/u)) {
    const colon = line.indexOf(":");
    if (colon === -1) {
      continue;
    }
    headers.set(
      line.slice(0, colon).trim().toLowerCase(),
      line.slice(colon + 1).trim(),
    );
  }
  const from = parseFromHeader(headers.get("from"));
  const transferEncoding = headers
    .get("content-transfer-encoding")
    ?.toLowerCase();
  const body =
    transferEncoding === "base64"
      ? Buffer.from(bodyText.replace(/\s/gu, ""), "base64").toString("utf8")
      : bodyText;
  return {
    from: from.address,
    ...(from.name ? { fromName: from.name } : {}),
    to: parseAddressList(headers.get("to")),
    cc: parseAddressList(headers.get("cc")),
    bcc: parseAddressList(headers.get("bcc")),
    subject: decodeHeader(headers.get("subject") ?? ""),
    body,
    ...(headers.get("reply-to")
      ? { replyTo: decodeHeader(headers.get("reply-to")!) }
      : {}),
    ...(headers.get("in-reply-to")
      ? { inReplyTo: headers.get("in-reply-to")! }
      : {}),
    references: (headers.get("references") ?? "").split(/\s+/u).filter(Boolean),
  };
}

async function gmailCreateDraft(args: {
  readonly accessToken: string;
  readonly details: MailDetails;
  readonly gmailThreadId?: string;
  readonly signal: AbortSignal;
}): Promise<GmailDraftValue> {
  const response = await fetch(`${GMAIL_API_BASE}/drafts`, {
    method: "POST",
    signal: args.signal,
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: {
        raw: gmailRawMessage(args.details),
        ...(args.gmailThreadId ? { threadId: args.gmailThreadId } : {}),
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`Gmail rejected draft creation (HTTP ${response.status})`);
  }
  const draft = gmailDraftResourceSchema.parse(await response.json());
  return {
    draftId: draft.id,
    messageId: draft.message.id,
    threadId: draft.message.threadId,
    details: args.details,
  };
}

async function gmailGetDraft(args: {
  readonly accessToken: string;
  readonly gmailDraftId: string;
  readonly signal: AbortSignal;
}): Promise<GmailDraftValue | null> {
  const response = await fetch(
    `${GMAIL_API_BASE}/drafts/${encodeURIComponent(args.gmailDraftId)}?format=raw`,
    {
      signal: args.signal,
      headers: { Authorization: `Bearer ${args.accessToken}` },
    },
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Failed to read Gmail draft (HTTP ${response.status})`);
  }
  const draft = gmailDraftResourceSchema.parse(await response.json());
  if (!draft.message.raw) {
    throw new Error("Gmail draft response did not include raw content");
  }
  return {
    draftId: draft.id,
    messageId: draft.message.id,
    threadId: draft.message.threadId,
    details: parseRawMail(draft.message.raw),
  };
}

async function gmailUpdateDraft(args: {
  readonly accessToken: string;
  readonly gmailDraftId: string;
  readonly gmailThreadId: string;
  readonly details: MailDetails;
  readonly signal: AbortSignal;
}): Promise<GmailDraftValue | null> {
  const response = await fetch(
    `${GMAIL_API_BASE}/drafts/${encodeURIComponent(args.gmailDraftId)}`,
    {
      method: "PUT",
      signal: args.signal,
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: args.gmailDraftId,
        message: {
          raw: gmailRawMessage(args.details),
          threadId: args.gmailThreadId,
        },
      }),
    },
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(
      `Gmail rejected the draft update (HTTP ${response.status})`,
    );
  }
  const draft = gmailDraftResourceSchema.parse(await response.json());
  return {
    draftId: draft.id,
    messageId: draft.message.id,
    threadId: draft.message.threadId,
    details: args.details,
  };
}

async function gmailSendDraft(args: {
  readonly accessToken: string;
  readonly gmailDraftId: string;
  readonly gmailThreadId: string;
  readonly details: MailDetails;
  readonly signal: AbortSignal;
}): Promise<GmailSentValue | null> {
  const response = await fetch(`${GMAIL_API_BASE}/drafts/send`, {
    method: "POST",
    signal: args.signal,
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: args.gmailDraftId,
      message: {
        raw: gmailRawMessage(args.details),
        threadId: args.gmailThreadId,
      },
    }),
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Gmail rejected the draft send (HTTP ${response.status})`);
  }
  const message = gmailMessageResourceSchema.parse(await response.json());
  return {
    messageId: message.id,
    threadId: message.threadId,
    details: args.details,
  };
}

async function gmailGetMessage(args: {
  readonly accessToken: string;
  readonly gmailMessageId: string;
  readonly signal: AbortSignal;
}): Promise<GmailSentValue | null> {
  const response = await fetch(
    `${GMAIL_API_BASE}/messages/${encodeURIComponent(args.gmailMessageId)}?format=raw`,
    {
      signal: args.signal,
      headers: { Authorization: `Bearer ${args.accessToken}` },
    },
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(
      `Failed to read sent Gmail message (HTTP ${response.status})`,
    );
  }
  const message = gmailMessageResourceSchema.parse(await response.json());
  return {
    messageId: message.id,
    threadId: message.threadId,
    details: message.raw ? parseRawMail(message.raw) : null,
  };
}

async function gmailDeleteDraft(args: {
  readonly accessToken: string;
  readonly gmailDraftId: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  const response = await fetch(
    `${GMAIL_API_BASE}/drafts/${encodeURIComponent(args.gmailDraftId)}`,
    {
      method: "DELETE",
      signal: args.signal,
      headers: { Authorization: `Bearer ${args.accessToken}` },
    },
  );
  if (response.status !== 204 && response.status !== 404) {
    throw new Error(`Gmail rejected draft deletion (HTTP ${response.status})`);
  }
}

function detailsFromLegacy(draft: ZeroMailLegacyDraft): MailDetails {
  return {
    from: draft.from,
    to: draft.to,
    cc: [],
    bcc: [],
    subject: draft.subject,
    body: draft.body,
    references: [],
  };
}

function responseDetails(
  row: NewMailDraftRow,
  details: MailDetails | null,
): MailDetails {
  if (details) {
    return details;
  }
  return {
    from: row.senderAddress,
    ...(row.senderName ? { fromName: row.senderName } : {}),
    to: [],
    cc: [],
    bcc: [],
    subject: row.subject,
    body: "",
    references: [],
  };
}

function legacyStatusForResourceStatus(
  status: ZeroMailDraftResourceStatus,
): ZeroMailLegacyDraft["status"] {
  switch (status) {
    case "draft": {
      return "draft";
    }
    case "sent": {
      return "sent";
    }
    case "deleted": {
      return "cancelled";
    }
  }
}

function optionalString(value: string | null): string | undefined {
  return value ?? undefined;
}

function optionalTimestamp(value: Date | null): string | undefined {
  return value?.toISOString();
}

function responseDraft(args: {
  readonly row: NewMailDraftRow;
  readonly details: MailDetails | null;
  readonly detailAvailable: boolean;
}): ZeroMailDraft {
  const { row, details } = args;
  const response = responseDetails(row, details);
  return zeroMailDraftSchema.parse({
    version: 2,
    provider: "gmail",
    from: response.from,
    fromName: response.fromName,
    to: response.to,
    cc: response.cc,
    bcc: response.bcc,
    subject: response.subject,
    body: response.body,
    replyTo: response.replyTo,
    inReplyTo: response.inReplyTo,
    references: response.references,
    status: legacyStatusForResourceStatus(row.status),
    resourceStatus: row.status,
    detailAvailable: args.detailAvailable,
    gmailDraftId: optionalString(row.gmailDraftId),
    gmailThreadId: optionalString(row.gmailThreadId),
    gmailMessageId: optionalString(row.gmailMessageId),
    sentGmailMessageId: optionalString(row.sentGmailMessageId),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    sentAt: optionalTimestamp(row.sentAt),
  });
}

function responseDraftFromLegacy(row: LegacyMailDraftRow): ZeroMailDraft {
  const resourceStatus: ZeroMailDraftResourceStatus =
    row.draft.status === "sent"
      ? "sent"
      : row.draft.status === "cancelled"
        ? "deleted"
        : "draft";
  return zeroMailDraftSchema.parse({
    version: 2,
    provider: "gmail",
    from: row.draft.from,
    to: row.draft.to,
    cc: [],
    bcc: [],
    subject: row.draft.subject,
    body: row.draft.body,
    references: [],
    status: row.draft.status,
    resourceStatus,
    detailAvailable: resourceStatus !== "deleted",
    createdAt: row.draft.createdAt,
    updatedAt: row.draft.updatedAt,
    sentAt: row.draft.sentAt,
  });
}

async function connectionForRow(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
  readonly row: StoredMailDraftRow;
}): Promise<MailConnection | null> {
  const connections = await loadMailConnections({
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    agentId: args.row.agentId,
  });
  if (args.row.kind === "gmail") {
    const connectorId = args.row.connectorId;
    return (
      connections.find((connection) => {
        return connection.connectorId === connectorId;
      }) ?? null
    );
  }
  const senderAddress = args.row.draft.from;
  return (
    connections.find((connection) => {
      return connection.externalEmail === senderAddress;
    }) ?? null
  );
}

async function accessForRow(args: {
  readonly db: ReadonlyDb;
  readonly writeDb: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly row: StoredMailDraftRow;
  readonly signal: AbortSignal;
}): Promise<
  { readonly kind: "ok"; readonly accessToken: string } | MailDraftErrorResult
> {
  const connection = await connectionForRow(args);
  if (!connection) {
    return { kind: "conflict", message: "Reconnect Gmail before continuing" };
  }
  const access = await resolveMailAccessToken({
    connection,
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    signal: args.signal,
    writeDb: args.writeDb,
  });
  return access.kind === "ok"
    ? access
    : { kind: "conflict", message: access.message };
}

async function persistCreatedDraft(args: {
  readonly db: Db;
  readonly mailDraftId: string;
  readonly gmail: GmailDraftValue;
  readonly connection: MailConnection;
  readonly threadId: string;
  readonly userId: string;
}): Promise<void> {
  const createdAt = nowDate();
  const link = mailDraftUrl(args.mailDraftId);
  const created = await args.db.transaction(async (tx) => {
    const message = await insertChatMessage(tx, {
      chatThreadId: args.threadId,
      role: "assistant",
      content: link,
    });
    if (!message) {
      throw new Error("Mail draft message insert did not return an id");
    }
    await tx.insert(mailDrafts).values({
      id: args.mailDraftId,
      draft: null,
      chatThreadId: args.threadId,
      connectorId: args.connection.connectorId,
      gmailDraftId: args.gmail.draftId,
      gmailThreadId: args.gmail.threadId,
      gmailMessageId: args.gmail.messageId,
      status: "draft",
      senderName: args.gmail.details.fromName ?? null,
      senderAddress: args.gmail.details.from,
      subject: args.gmail.details.subject,
      createdAt,
      updatedAt: createdAt,
    });
    return message.id;
  });
  await tapError(
    publishUserSignal(
      [args.userId],
      `chatThreadMessageCreated:${args.threadId}`,
    ),
    (error) => {
      L.warn("Failed to publish Gmail draft creation", {
        threadId: args.threadId,
        messageId: created,
        error,
      });
    },
  );
}

async function markDeleted(args: {
  readonly db: Db;
  readonly row: NewMailDraftRow;
}): Promise<NewMailDraftRow> {
  const updatedAt = nowDate();
  await args.db
    .update(mailDrafts)
    .set({ status: "deleted", updatedAt })
    .where(eq(mailDrafts.id, args.row.id));
  return { ...args.row, status: "deleted", updatedAt };
}

async function updateNewRowFromDraft(args: {
  readonly db: Db;
  readonly row: NewMailDraftRow;
  readonly gmail: GmailDraftValue;
}): Promise<NewMailDraftRow> {
  const updatedAt = nowDate();
  await args.db
    .update(mailDrafts)
    .set({
      gmailDraftId: args.gmail.draftId,
      gmailThreadId: args.gmail.threadId,
      gmailMessageId: args.gmail.messageId,
      senderName: args.gmail.details.fromName ?? null,
      senderAddress: args.gmail.details.from,
      subject: args.gmail.details.subject,
      updatedAt,
    })
    .where(eq(mailDrafts.id, args.row.id));
  return {
    ...args.row,
    gmailDraftId: args.gmail.draftId,
    gmailThreadId: args.gmail.threadId,
    gmailMessageId: args.gmail.messageId,
    senderName: args.gmail.details.fromName ?? null,
    senderAddress: args.gmail.details.from,
    subject: args.gmail.details.subject,
    updatedAt,
  };
}

async function getNewDraft(args: {
  readonly db: ReadonlyDb;
  readonly writeDb: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly row: NewMailDraftRow;
  readonly signal: AbortSignal;
}): Promise<ZeroMailDraftMutationResult> {
  if (args.row.status === "deleted") {
    return okResult(
      args.row.id,
      responseDraft({ row: args.row, details: null, detailAvailable: false }),
    );
  }
  const access = await accessForRow(args);
  if (access.kind !== "ok") {
    return access;
  }
  if (args.row.status === "sent") {
    if (!args.row.sentGmailMessageId) {
      return okResult(
        args.row.id,
        responseDraft({ row: args.row, details: null, detailAvailable: false }),
      );
    }
    const sent = await gmailGetMessage({
      accessToken: access.accessToken,
      gmailMessageId: args.row.sentGmailMessageId,
      signal: args.signal,
    });
    return okResult(
      args.row.id,
      responseDraft({
        row: args.row,
        details: sent?.details ?? null,
        detailAvailable: sent?.details !== null && sent !== null,
      }),
    );
  }
  if (!args.row.gmailDraftId) {
    throw new Error("Gmail draft row is missing gmailDraftId");
  }
  const gmail = await gmailGetDraft({
    accessToken: access.accessToken,
    gmailDraftId: args.row.gmailDraftId,
    signal: args.signal,
  });
  if (!gmail) {
    const deleted = await markDeleted({ db: args.writeDb, row: args.row });
    return okResult(
      args.row.id,
      responseDraft({ row: deleted, details: null, detailAvailable: false }),
    );
  }
  const updatedRow = await updateNewRowFromDraft({
    db: args.writeDb,
    row: args.row,
    gmail,
  });
  return okResult(
    args.row.id,
    responseDraft({
      row: updatedRow,
      details: gmail.details,
      detailAvailable: true,
    }),
  );
}

async function replaceLegacyDraft(args: {
  readonly db: Db;
  readonly row: LegacyMailDraftRow;
  readonly draft: ZeroMailLegacyDraft;
}): Promise<LegacyMailDraftRow> {
  await args.db
    .update(mailDrafts)
    .set({ draft: args.draft, updatedAt: nowDate() })
    .where(eq(mailDrafts.id, args.row.id));
  return { ...args.row, draft: args.draft };
}

export const createZeroMailDraft$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly threadId: string;
      readonly agentId?: string;
      readonly provider?: ZeroMailProvider;
      readonly to: readonly string[];
      readonly cc?: readonly string[];
      readonly bcc?: readonly string[];
      readonly subject: string;
      readonly body: string;
      readonly replyTo?: string;
      readonly inReplyTo?: string;
      readonly references?: readonly string[];
      readonly gmailThreadId?: string;
    },
    signal: AbortSignal,
  ): Promise<ZeroMailDraftMutationResult> => {
    if (args.provider === "outlook") {
      return {
        kind: "conflict",
        message: "Mail draft cards now require Gmail",
      };
    }
    const db = get(db$);
    const threadAgentId = await ownedThreadAgentId({ db, ...args });
    signal.throwIfAborted();
    if (!threadAgentId || (args.agentId && threadAgentId !== args.agentId)) {
      return { kind: "not_found", message: "Chat thread not found" };
    }
    const connections = (
      await loadMailConnections({
        db,
        orgId: args.orgId,
        userId: args.userId,
        agentId: threadAgentId,
      })
    ).filter((connection) => {
      return !connection.needsReconnect && connection.scopesReady;
    });
    signal.throwIfAborted();
    const connection = connections.length === 1 ? connections[0] : undefined;
    if (!connection) {
      return {
        kind: "conflict",
        message:
          connections.length === 0
            ? "Connect and authorize Gmail for this agent first"
            : "The agent has more than one Gmail connection",
      };
    }
    const access = await resolveMailAccessToken({
      connection,
      db,
      orgId: args.orgId,
      userId: args.userId,
      signal,
      writeDb: set(writeDb$),
    });
    if (access.kind !== "ok") {
      return { kind: "conflict", message: access.message };
    }
    const details: MailDetails = {
      from: connection.externalEmail,
      ...(connection.externalUsername
        ? { fromName: connection.externalUsername }
        : {}),
      to: args.to,
      cc: args.cc ?? [],
      bcc: args.bcc ?? [],
      subject: args.subject,
      body: args.body,
      ...(args.replyTo ? { replyTo: args.replyTo } : {}),
      ...(args.inReplyTo ? { inReplyTo: args.inReplyTo } : {}),
      references: args.references ?? [],
    };
    const gmail = await gmailCreateDraft({
      accessToken: access.accessToken,
      details,
      gmailThreadId: args.gmailThreadId,
      signal,
    });
    signal.throwIfAborted();
    const mailDraftId = randomUUID();
    await persistCreatedDraft({
      db: set(writeDb$),
      mailDraftId,
      gmail,
      connection,
      threadId: args.threadId,
      userId: args.userId,
    });
    signal.throwIfAborted();
    const stored = await loadOwnedNewMailDraft({
      db,
      orgId: args.orgId,
      userId: args.userId,
      mailDraftId,
    });
    signal.throwIfAborted();
    if (!stored) {
      throw new Error("Created Gmail draft row could not be loaded");
    }
    return okResult(
      mailDraftId,
      responseDraft({ row: stored, details, detailAvailable: true }),
    );
  },
);

export const getZeroMailDraft$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly mailDraftId: string;
    },
    signal: AbortSignal,
  ): Promise<ZeroMailDraftMutationResult> => {
    const db = get(db$);
    const row = await loadOwnedMailDraft({ db, ...args });
    signal.throwIfAborted();
    if (!row) {
      return { kind: "not_found", message: "Mail draft not found" };
    }
    if (row.kind === "legacy") {
      return okResult(row.id, responseDraftFromLegacy(row));
    }
    return await getNewDraft({
      db,
      writeDb: set(writeDb$),
      orgId: args.orgId,
      userId: args.userId,
      row,
      signal,
    });
  },
);

export const updateZeroMailDraft$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly mailDraftId: string;
      readonly to: readonly string[];
      readonly cc?: readonly string[];
      readonly bcc?: readonly string[];
      readonly subject: string;
      readonly body: string;
    },
    signal: AbortSignal,
  ): Promise<ZeroMailDraftMutationResult> => {
    const db = get(db$);
    const row = await loadOwnedMailDraft({ db, ...args });
    signal.throwIfAborted();
    if (!row) {
      return { kind: "not_found", message: "Mail draft not found" };
    }
    if (row.kind === "legacy") {
      if (row.draft.status !== "draft" && row.draft.status !== "failed") {
        return {
          kind: "conflict",
          message: "This mail draft cannot be edited",
        };
      }
      const updated = await replaceLegacyDraft({
        db: set(writeDb$),
        row,
        draft: {
          ...row.draft,
          to: [...args.to],
          subject: args.subject,
          body: args.body,
          status: "draft",
          updatedAt: nowDate().toISOString(),
          error: undefined,
        },
      });
      signal.throwIfAborted();
      return okResult(updated.id, responseDraftFromLegacy(updated));
    }
    if (row.status !== "draft" || !row.gmailDraftId) {
      return { kind: "conflict", message: "This mail draft cannot be edited" };
    }
    const access = await accessForRow({
      db,
      writeDb: set(writeDb$),
      orgId: args.orgId,
      userId: args.userId,
      row,
      signal,
    });
    if (access.kind !== "ok") {
      return access;
    }
    const current = await gmailGetDraft({
      accessToken: access.accessToken,
      gmailDraftId: row.gmailDraftId,
      signal,
    });
    if (!current) {
      const deleted = await markDeleted({ db: set(writeDb$), row });
      signal.throwIfAborted();
      return okResult(
        row.id,
        responseDraft({ row: deleted, details: null, detailAvailable: false }),
      );
    }
    const details: MailDetails = {
      ...current.details,
      to: args.to,
      cc: args.cc ?? current.details.cc,
      bcc: args.bcc ?? current.details.bcc,
      subject: args.subject,
      body: args.body,
    };
    const gmail = await gmailUpdateDraft({
      accessToken: access.accessToken,
      gmailDraftId: row.gmailDraftId,
      gmailThreadId: current.threadId,
      details,
      signal,
    });
    if (!gmail) {
      const deleted = await markDeleted({ db: set(writeDb$), row });
      signal.throwIfAborted();
      return okResult(
        row.id,
        responseDraft({ row: deleted, details: null, detailAvailable: false }),
      );
    }
    const updatedRow = await updateNewRowFromDraft({
      db: set(writeDb$),
      row,
      gmail,
    });
    signal.throwIfAborted();
    return okResult(
      row.id,
      responseDraft({ row: updatedRow, details, detailAvailable: true }),
    );
  },
);

export const deleteZeroMailDraft$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly mailDraftId: string;
    },
    signal: AbortSignal,
  ): Promise<ZeroMailDraftMutationResult> => {
    const db = get(db$);
    const row = await loadOwnedMailDraft({ db, ...args });
    signal.throwIfAborted();
    if (!row) {
      return { kind: "not_found", message: "Mail draft not found" };
    }
    if (row.kind === "gmail") {
      if (row.status !== "draft" || !row.gmailDraftId) {
        return {
          kind: "conflict",
          message: "Only an active draft can be deleted",
        };
      }
      const access = await accessForRow({
        db,
        writeDb: set(writeDb$),
        orgId: args.orgId,
        userId: args.userId,
        row,
        signal,
      });
      if (access.kind !== "ok") {
        return access;
      }
      await gmailDeleteDraft({
        accessToken: access.accessToken,
        gmailDraftId: row.gmailDraftId,
        signal,
      });
      signal.throwIfAborted();
    }
    const deletedDraft =
      row.kind === "gmail"
        ? responseDraft({
            row: { ...row, status: "deleted" },
            details: null,
            detailAvailable: false,
          })
        : responseDraftFromLegacy({
            ...row,
            draft: {
              ...row.draft,
              status: "cancelled",
              updatedAt: nowDate().toISOString(),
            },
          });
    await set(writeDb$).delete(mailDrafts).where(eq(mailDrafts.id, row.id));
    signal.throwIfAborted();
    return okResult(row.id, deletedDraft);
  },
);

export const deleteZeroMailDraftsForThread$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly threadId: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const rows = await get(db$)
      .select({ id: mailDrafts.id })
      .from(mailDrafts)
      .innerJoin(chatThreads, eq(chatThreads.id, mailDrafts.chatThreadId))
      .innerJoin(
        agentComposes,
        eq(agentComposes.id, chatThreads.agentComposeId),
      )
      .where(
        and(
          eq(mailDrafts.chatThreadId, args.threadId),
          eq(mailDrafts.status, "draft"),
          eq(chatThreads.userId, args.userId),
          eq(agentComposes.orgId, args.orgId),
        ),
      );
    signal.throwIfAborted();
    for (const row of rows) {
      const result = await set(
        deleteZeroMailDraft$,
        { ...args, mailDraftId: row.id },
        signal,
      );
      if (result.kind !== "ok") {
        throw new Error(result.message);
      }
      signal.throwIfAborted();
    }
  },
);

interface SendDraftFields {
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly subject: string;
  readonly body: string;
}

async function sendLegacyZeroMailDraft(args: {
  readonly db: ReadonlyDb;
  readonly writeDb: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly row: LegacyMailDraftRow;
  readonly fields: SendDraftFields;
  readonly signal: AbortSignal;
}): Promise<ZeroMailDraftMutationResult> {
  if (
    args.row.draft.status === "sent" ||
    args.row.draft.status === "cancelled"
  ) {
    return {
      kind: "conflict",
      message: "This mail draft can no longer be sent",
    };
  }
  const access = await accessForRow(args);
  if (access.kind !== "ok") {
    return access;
  }
  const details: MailDetails = {
    ...detailsFromLegacy(args.row.draft),
    to: args.fields.to,
    subject: args.fields.subject,
    body: args.fields.body,
  };
  const response = await fetch(`${GMAIL_API_BASE}/messages/send`, {
    method: "POST",
    signal: args.signal,
    headers: {
      Authorization: `Bearer ${access.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw: gmailRawMessage(details) }),
  });
  if (!response.ok) {
    throw new Error(`Gmail rejected the message (HTTP ${response.status})`);
  }
  const timestamp = nowDate().toISOString();
  const updated = await replaceLegacyDraft({
    db: args.writeDb,
    row: args.row,
    draft: {
      ...args.row.draft,
      to: [...args.fields.to],
      subject: args.fields.subject,
      body: args.fields.body,
      status: "sent",
      updatedAt: timestamp,
      sentAt: timestamp,
      error: undefined,
    },
  });
  return okResult(updated.id, responseDraftFromLegacy(updated));
}

async function sendNewZeroMailDraft(args: {
  readonly db: ReadonlyDb;
  readonly writeDb: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly row: NewMailDraftRow;
  readonly fields: SendDraftFields;
  readonly signal: AbortSignal;
}): Promise<ZeroMailDraftMutationResult> {
  if (args.row.status !== "draft" || !args.row.gmailDraftId) {
    return {
      kind: "conflict",
      message: "This mail draft can no longer be sent",
    };
  }
  const access = await accessForRow(args);
  if (access.kind !== "ok") {
    return access;
  }
  const current = await gmailGetDraft({
    accessToken: access.accessToken,
    gmailDraftId: args.row.gmailDraftId,
    signal: args.signal,
  });
  if (!current) {
    const deleted = await markDeleted({ db: args.writeDb, row: args.row });
    return okResult(
      args.row.id,
      responseDraft({ row: deleted, details: null, detailAvailable: false }),
    );
  }
  const details: MailDetails = {
    ...current.details,
    to: args.fields.to,
    cc: args.fields.cc ?? current.details.cc,
    bcc: args.fields.bcc ?? current.details.bcc,
    subject: args.fields.subject,
    body: args.fields.body,
  };
  const sent = await gmailSendDraft({
    accessToken: access.accessToken,
    gmailDraftId: args.row.gmailDraftId,
    gmailThreadId: current.threadId,
    details,
    signal: args.signal,
  });
  if (!sent) {
    const deleted = await markDeleted({ db: args.writeDb, row: args.row });
    return okResult(
      args.row.id,
      responseDraft({ row: deleted, details: null, detailAvailable: false }),
    );
  }
  const sentAt = nowDate();
  await args.writeDb
    .update(mailDrafts)
    .set({
      status: "sent",
      gmailThreadId: sent.threadId,
      sentGmailMessageId: sent.messageId,
      senderName: details.fromName ?? null,
      senderAddress: details.from,
      subject: details.subject,
      sentAt,
      updatedAt: sentAt,
    })
    .where(eq(mailDrafts.id, args.row.id));
  const sentRow: NewMailDraftRow = {
    ...args.row,
    status: "sent",
    gmailThreadId: sent.threadId,
    sentGmailMessageId: sent.messageId,
    senderName: details.fromName ?? null,
    senderAddress: details.from,
    subject: details.subject,
    sentAt,
    updatedAt: sentAt,
  };
  return okResult(
    args.row.id,
    responseDraft({ row: sentRow, details, detailAvailable: true }),
  );
}

export const sendZeroMailDraft$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly mailDraftId: string;
      readonly to: readonly string[];
      readonly cc?: readonly string[];
      readonly bcc?: readonly string[];
      readonly subject: string;
      readonly body: string;
    },
    signal: AbortSignal,
  ): Promise<ZeroMailDraftMutationResult> => {
    const db = get(db$);
    const row = await loadOwnedMailDraft({ db, ...args });
    signal.throwIfAborted();
    if (!row) {
      return { kind: "not_found", message: "Mail draft not found" };
    }
    const shared = {
      db,
      writeDb: set(writeDb$),
      orgId: args.orgId,
      userId: args.userId,
      fields: args,
      signal,
    };
    return row.kind === "legacy"
      ? await sendLegacyZeroMailDraft({ ...shared, row })
      : await sendNewZeroMailDraft({ ...shared, row });
  },
);
