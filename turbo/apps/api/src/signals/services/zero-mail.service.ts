import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import {
  zeroMailDraftSchema,
  zeroMailDraftStatusSchema,
  type ZeroMailAttachment,
  type ZeroMailDraft,
  type ZeroMailDraftStatus,
  type ZeroMailInlineImage,
} from "@vm0/api-contracts/contracts/zero-mail";
import { connectorAuthMethodHasRequiredScopes } from "@vm0/connectors/connector-utils";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { connectors } from "@vm0/db/schema/connector";
import { mailDrafts } from "@vm0/db/schema/mail-draft";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { convert } from "html-to-text";
import { z } from "zod";

import { pgTextDecoder } from "../../lib/db-structured-result";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { db$, writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { nowDate } from "../external/time";
import { tapError } from "../utils";
import {
  loadConnectorRuntimeSnapshot,
  type ConnectorRuntimeSnapshot,
} from "./connector-catalog-runtime.service";
import { resolveConnectorCredentialAccess } from "./connector-credential-access.service";
import {
  connectorCredentialRuntimeValueRef,
  loadConnectorCredentialValues,
  refreshConnectorCredentialAccess,
  type ConnectorCredentialConnection,
} from "./connector-credential-runtime.service";

const L = logger("api:zero-mail");

const TOKEN_REFRESH_SKEW_MS = 60_000;
const DEFAULT_ACCESS_TOKEN_EXPIRES_IN_MS = 60 * 60 * 1000;
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const GMAIL_ACCESS_TOKEN_ENV = "GMAIL_TOKEN";
const oauthScopesSchema = z.array(z.string());

interface GmailMessagePart {
  readonly partId: string;
  readonly mimeType: string;
  readonly filename: string;
  readonly headers: readonly {
    readonly name: string;
    readonly value: string;
  }[];
  readonly body: {
    readonly attachmentId?: string;
    readonly size: number;
    readonly data?: string;
  };
  readonly parts?: readonly GmailMessagePart[];
}

const gmailMessagePartSchema: z.ZodType<GmailMessagePart> = z.lazy(() => {
  return z.object({
    partId: z.string(),
    mimeType: z.string(),
    filename: z.string().default(""),
    headers: z
      .array(z.object({ name: z.string(), value: z.string() }))
      .default([]),
    body: z.object({
      attachmentId: z.string().optional(),
      size: z.number().int().nonnegative().default(0),
      data: z.string().optional(),
    }),
    parts: z.array(gmailMessagePartSchema).optional(),
  });
});

const gmailDraftResourceSchema = z.object({
  id: z.string(),
  message: z.object({
    id: z.string(),
    threadId: z.string(),
    payload: gmailMessagePartSchema,
  }),
});

const gmailMessageResourceSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  payload: gmailMessagePartSchema,
});

const gmailSentResourceSchema = z.object({
  id: z.string(),
  threadId: z.string(),
});

const gmailAttachmentResourceSchema = z.object({
  size: z.number().int().nonnegative(),
  data: z.string(),
});

interface MailConnection extends ConnectorCredentialConnection {
  readonly connectorRef: "gmail";
  readonly externalEmail: string;
  readonly externalUsername: string | null;
  readonly scopesReady: boolean;
}

interface MailDraftResult {
  readonly kind: "ok";
  readonly mailDraftId: string;
  readonly mailDraftUrl: string;
  readonly mailDraft: ZeroMailDraft;
}

interface MailDraftLinkResult {
  readonly kind: "ok";
  readonly mailDraftId: string;
  readonly mailDraftUrl: string;
}

interface MailDraftAttachmentResult {
  readonly kind: "ok";
  readonly content: Uint8Array;
  readonly contentType: string;
  readonly filename: string;
}

interface MailDraftErrorResult {
  readonly kind: "not_found" | "conflict";
  readonly message: string;
}

export type ZeroMailDraftMutationResult =
  | MailDraftResult
  | MailDraftErrorResult;

export type ZeroMailDraftLinkMutationResult =
  | MailDraftLinkResult
  | MailDraftErrorResult;

type ZeroMailDraftAttachmentResult =
  | MailDraftAttachmentResult
  | MailDraftErrorResult;

interface MailDraftRow {
  readonly id: string;
  readonly agentId: string;
  readonly chatThreadId: string;
  readonly connectorId: string | null;
  readonly gmailDraftId: string;
  readonly gmailThreadId: string;
  readonly gmailMessageId: string;
  readonly sentGmailMessageId: string | null;
  readonly status: ZeroMailDraftStatus;
  readonly senderName: string | null;
  readonly senderAddress: string;
  readonly subject: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly sentAt: Date | null;
}

interface StoredMailDraftRow {
  readonly id: string;
  readonly agentId: string;
  readonly chatThreadId: string;
  readonly connectorId: string | null;
  readonly gmailDraftId: string | null;
  readonly gmailThreadId: string | null;
  readonly gmailMessageId: string | null;
  readonly sentGmailMessageId: string | null;
  readonly status: ZeroMailDraftStatus | null;
  readonly senderName: string | null;
  readonly senderAddress: string | null;
  readonly subject: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly sentAt: Date | null;
}

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
  readonly bodyHtml?: string;
  readonly inlineImages?: readonly ZeroMailInlineImage[];
  readonly replyTo?: string;
  readonly inReplyTo?: string;
  readonly references: readonly string[];
  readonly attachments: readonly ZeroMailAttachment[];
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

interface MailAccess {
  readonly kind: "ok";
  readonly accessToken: string;
  readonly connection: MailConnection;
}

function mailDraftUrl(mailDraftId: string): string {
  return `${env("APP_URL").replace(/\/+$/u, "")}/mail/drafts/${mailDraftId}`;
}

function linkResult(mailDraftId: string): MailDraftLinkResult {
  return {
    kind: "ok",
    mailDraftId,
    mailDraftUrl: mailDraftUrl(mailDraftId),
  };
}

function okResult(
  mailDraftId: string,
  mailDraft: ZeroMailDraft,
): MailDraftResult {
  return {
    ...linkResult(mailDraftId),
    mailDraft,
  };
}

async function loadMailConnections(args: {
  readonly db: ReadonlyDb;
  readonly snapshot: ConnectorRuntimeSnapshot;
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
}): Promise<readonly MailConnection[]> {
  const rows = await args.db
    .select({
      connectorId: connectors.id,
      connectorType: connectors.type,
      authMethod: connectors.authMethod,
      externalEmail: connectors.externalEmail,
      externalUsername: connectors.externalUsername,
      externalId: connectors.externalId,
      needsReconnect: connectors.needsReconnect,
      oauthScopes: connectors.oauthScopes,
      stateRevision: sql`${connectors.updatedAt}::text`.mapWith(pgTextDecoder),
      storageVersion: connectors.storageVersion,
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
    if (row.connectorType !== "gmail" || !row.externalEmail) {
      return [];
    }
    const accessResult = resolveConnectorCredentialAccess({
      snapshot: args.snapshot,
      stored: {
        authMethodId: row.authMethod,
        connectorId: row.connectorId,
        connectorRef: row.connectorType,
        orgId: args.orgId,
        storageVersion: row.storageVersion,
        userId: args.userId,
      },
    });
    if (accessResult.kind !== "ok") {
      return [];
    }
    const { access } = accessResult;
    const runtimeMethod = access.runtimeMethod;
    const oauthScopes = row.oauthScopes
      ? oauthScopesSchema.parse(JSON.parse(row.oauthScopes))
      : null;
    return [
      {
        access,
        connectorId: row.connectorId,
        connectorRef: row.connectorType,
        runtimeMethod,
        externalEmail: row.externalEmail,
        externalUsername: row.externalUsername,
        externalId: row.externalId,
        needsReconnect: row.needsReconnect,
        oauthScopes,
        stateRevision: row.stateRevision,
        storageVersion: access.storageVersion,
        scopesReady: connectorAuthMethodHasRequiredScopes(
          runtimeMethod.method,
          oauthScopes,
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

async function loadOwnedMailDraft(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
  readonly mailDraftId: string;
}): Promise<MailDraftRow | null> {
  const [row]: readonly StoredMailDraftRow[] = await args.db
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
  return mailDraftRow(row);
}

function mailDraftRow(
  row: StoredMailDraftRow | undefined,
): MailDraftRow | null {
  if (
    !row?.gmailDraftId ||
    !row.gmailThreadId ||
    !row.gmailMessageId ||
    !row.senderAddress ||
    !row.subject
  ) {
    return null;
  }
  const status = zeroMailDraftStatusSchema.safeParse(row.status);
  if (!status.success) {
    return null;
  }
  return {
    ...row,
    gmailDraftId: row.gmailDraftId,
    gmailThreadId: row.gmailThreadId,
    gmailMessageId: row.gmailMessageId,
    status: status.data,
    senderAddress: row.senderAddress,
    subject: row.subject,
  };
}

async function loadLinkedDraft(args: {
  readonly db: ReadonlyDb;
  readonly connectorId: string;
  readonly gmailDraftId: string;
}): Promise<{ readonly id: string; readonly chatThreadId: string } | null> {
  const [row] = await args.db
    .select({ id: mailDrafts.id, chatThreadId: mailDrafts.chatThreadId })
    .from(mailDrafts)
    .where(
      and(
        eq(mailDrafts.connectorId, args.connectorId),
        eq(mailDrafts.gmailDraftId, args.gmailDraftId),
      ),
    )
    .limit(1);
  return row?.chatThreadId ? { ...row, chatThreadId: row.chatThreadId } : null;
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
  const accessTokenValueRef = connectorCredentialRuntimeValueRef(
    args.connection,
    GMAIL_ACCESS_TOKEN_ENV,
  );
  if (accessTokenValueRef === null) {
    return { kind: "error", message: "Reconnect Gmail before continuing" };
  }
  const values = await loadConnectorCredentialValues({
    connection: args.connection,
    db: args.db,
    valueRefs: [accessTokenValueRef],
  });
  const expiresAt = args.connection.tokenExpiresAt?.getTime() ?? 0;
  const accessToken = values.get(accessTokenValueRef);
  if (
    accessToken &&
    (expiresAt === 0 || expiresAt > nowDate().getTime() + TOKEN_REFRESH_SKEW_MS)
  ) {
    return { kind: "ok", accessToken };
  }
  const refreshed = await refreshConnectorCredentialAccess({
    connection: args.connection,
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    runtimeEnvironmentName: GMAIL_ACCESS_TOKEN_ENV,
    signal: args.signal,
    persist: {
      db: args.writeDb,
      defaultExpiresInMs: DEFAULT_ACCESS_TOKEN_EXPIRES_IN_MS,
    },
  });
  if (refreshed.kind === "configuration-unavailable") {
    return { kind: "error", message: "Gmail OAuth is not configured" };
  }
  return refreshed.kind === "ok"
    ? { kind: "ok", accessToken: refreshed.accessToken }
    : { kind: "error", message: "Reconnect Gmail before continuing" };
}

function decodeHeader(value: string): string {
  return value.replace(
    /=\?UTF-8\?([BQ])\?([^?]+)\?=/giu,
    (_match, encoding: string, encoded: string) => {
      if (encoding.toLowerCase() === "b") {
        return Buffer.from(encoded, "base64").toString("utf8");
      }
      const binary = encoded
        .replaceAll("_", " ")
        .replace(/=([0-9A-F]{2})/giu, (_escape, hex: string) => {
          return String.fromCharCode(Number.parseInt(hex, 16));
        });
      return Buffer.from(binary, "binary").toString("utf8");
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

function parseFromHeader(
  value: string | undefined,
  fallback: { readonly address: string; readonly name: string | null },
): { readonly address: string; readonly name?: string } {
  if (!value) {
    return fallback.name
      ? { address: fallback.address, name: fallback.name }
      : { address: fallback.address };
  }
  const decoded = decodeHeader(value).trim();
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

function headerValue(part: GmailMessagePart, name: string): string | undefined {
  return part.headers.find((header) => {
    return header.name.toLowerCase() === name.toLowerCase();
  })?.value;
}

function decodedPartBody(part: GmailMessagePart): string | null {
  return part.body.data
    ? Buffer.from(part.body.data, "base64url").toString("utf8")
    : null;
}

function findBodyPart(
  part: GmailMessagePart,
  mimeType: "text/plain" | "text/html",
): string | null {
  if (!part.filename && part.mimeType.toLowerCase() === mimeType) {
    return decodedPartBody(part);
  }
  for (const child of part.parts ?? []) {
    const body = findBodyPart(child, mimeType);
    if (body !== null) {
      return body;
    }
  }
  return null;
}

const htmlAttributesSchema = z.record(z.string(), z.string());

function normalizedContentId(value: string): string {
  return value
    .trim()
    .replace(/^cid:/iu, "")
    .replace(/^<|>$/gu, "")
    .toLowerCase();
}

function inlineImagePartsByContentId(
  part: GmailMessagePart,
): ReadonlyMap<string, GmailMessagePart> {
  const parts = new Map<string, GmailMessagePart>();
  const contentId = headerValue(part, "content-id");
  if (
    contentId &&
    part.partId &&
    part.mimeType.toLowerCase().startsWith("image/")
  ) {
    parts.set(normalizedContentId(contentId), part);
  }
  for (const child of part.parts ?? []) {
    for (const [childContentId, childPart] of inlineImagePartsByContentId(
      child,
    )) {
      parts.set(childContentId, childPart);
    }
  }
  return parts;
}

interface RichMailBody {
  readonly html: string;
  readonly inlineImages: readonly ZeroMailInlineImage[];
  readonly inlinePartIds: ReadonlySet<string>;
}

function richMailBody(
  payload: GmailMessagePart,
  htmlBody: string | null,
): RichMailBody | null {
  if (!htmlBody) {
    return null;
  }
  const mimeParts = inlineImagePartsByContentId(payload);
  const inlineImages: ZeroMailInlineImage[] = [];
  convert(htmlBody, {
    wordwrap: false,
    formatters: {
      inlineImage(element) {
        const attributes = htmlAttributesSchema.safeParse(element.attribs);
        if (!attributes.success) {
          return;
        }
        const source = attributes.data.src;
        if (!source?.toLowerCase().startsWith("cid:")) {
          return;
        }
        const mimePart = mimeParts.get(normalizedContentId(source));
        if (!mimePart) {
          return;
        }
        inlineImages.push({
          contentId: normalizedContentId(source),
          partId: mimePart.partId,
          alt:
            attributes.data.alt?.trim() ||
            decodeHeader(mimePart.filename) ||
            "Inline email image",
        });
      },
    },
    selectors: [{ selector: "img", format: "inlineImage" }],
  });
  return {
    html: htmlBody,
    inlineImages,
    inlinePartIds: new Set(
      inlineImages.map((image) => {
        return image.partId;
      }),
    ),
  };
}

function attachmentMetadata(
  part: GmailMessagePart,
  inlinePartIds: ReadonlySet<string>,
): readonly ZeroMailAttachment[] {
  if (inlinePartIds.has(part.partId)) {
    return [];
  }
  if (part.filename || part.body.attachmentId) {
    return [
      {
        filename: decodeHeader(part.filename || "attachment"),
        contentType: part.mimeType,
        size: part.body.size,
        ...(part.body.attachmentId ? { partId: part.partId } : {}),
      },
    ];
  }
  return (part.parts ?? []).flatMap((child) => {
    return attachmentMetadata(child, inlinePartIds);
  });
}

function mailDetailsFromPayload(
  payload: GmailMessagePart,
  fallbackSender: { readonly address: string; readonly name: string | null },
): MailDetails {
  const from = parseFromHeader(headerValue(payload, "from"), fallbackSender);
  const plainBody = findBodyPart(payload, "text/plain");
  const htmlBody = findBodyPart(payload, "text/html");
  const richBody = richMailBody(payload, htmlBody);
  return {
    from: from.address,
    ...(from.name ? { fromName: from.name } : {}),
    to: parseAddressList(headerValue(payload, "to")),
    cc: parseAddressList(headerValue(payload, "cc")),
    bcc: parseAddressList(headerValue(payload, "bcc")),
    subject: decodeHeader(headerValue(payload, "subject") ?? ""),
    body:
      plainBody ??
      (htmlBody ? convert(htmlBody, { wordwrap: false }).trim() : ""),
    ...(richBody
      ? {
          bodyHtml: richBody.html,
          inlineImages: richBody.inlineImages,
        }
      : {}),
    ...(headerValue(payload, "reply-to")
      ? { replyTo: decodeHeader(headerValue(payload, "reply-to")!) }
      : {}),
    ...(headerValue(payload, "in-reply-to")
      ? { inReplyTo: headerValue(payload, "in-reply-to")! }
      : {}),
    references: (headerValue(payload, "references") ?? "")
      .split(/\s+/u)
      .filter(Boolean),
    attachments: attachmentMetadata(
      payload,
      richBody?.inlinePartIds ?? new Set(),
    ),
  };
}

function findAttachmentPart(
  part: GmailMessagePart,
  partId: string,
): GmailMessagePart | null {
  if (part.partId === partId && part.body.attachmentId) {
    return part;
  }
  for (const child of part.parts ?? []) {
    const found = findAttachmentPart(child, partId);
    if (found) {
      return found;
    }
  }
  return null;
}

async function gmailGetDraftResource(args: {
  readonly accessToken: string;
  readonly gmailDraftId: string;
  readonly signal: AbortSignal;
}): Promise<z.infer<typeof gmailDraftResourceSchema> | null> {
  const response = await fetch(
    `${GMAIL_API_BASE}/drafts/${encodeURIComponent(args.gmailDraftId)}?format=full`,
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
  return gmailDraftResourceSchema.parse(await response.json());
}

async function gmailGetDraft(args: {
  readonly accessToken: string;
  readonly gmailDraftId: string;
  readonly fallbackSender: {
    readonly address: string;
    readonly name: string | null;
  };
  readonly signal: AbortSignal;
}): Promise<GmailDraftValue | null> {
  const draft = await gmailGetDraftResource(args);
  if (!draft) {
    return null;
  }
  return {
    draftId: draft.id,
    messageId: draft.message.id,
    threadId: draft.message.threadId,
    details: mailDetailsFromPayload(draft.message.payload, args.fallbackSender),
  };
}

async function gmailSendLinkedDraft(args: {
  readonly accessToken: string;
  readonly gmailDraftId: string;
  readonly signal: AbortSignal;
}): Promise<{ readonly messageId: string; readonly threadId: string } | null> {
  const response = await fetch(`${GMAIL_API_BASE}/drafts/send`, {
    method: "POST",
    signal: args.signal,
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id: args.gmailDraftId }),
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Gmail rejected the draft send (HTTP ${response.status})`);
  }
  const message = gmailSentResourceSchema.parse(await response.json());
  return { messageId: message.id, threadId: message.threadId };
}

async function gmailGetMessageResource(args: {
  readonly accessToken: string;
  readonly gmailMessageId: string;
  readonly signal: AbortSignal;
}): Promise<z.infer<typeof gmailMessageResourceSchema> | null> {
  const response = await fetch(
    `${GMAIL_API_BASE}/messages/${encodeURIComponent(args.gmailMessageId)}?format=full`,
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
  return gmailMessageResourceSchema.parse(await response.json());
}

async function gmailGetMessage(args: {
  readonly accessToken: string;
  readonly gmailMessageId: string;
  readonly fallbackSender: {
    readonly address: string;
    readonly name: string | null;
  };
  readonly signal: AbortSignal;
}): Promise<GmailSentValue | null> {
  const message = await gmailGetMessageResource(args);
  if (!message) {
    return null;
  }
  return {
    messageId: message.id,
    threadId: message.threadId,
    details: mailDetailsFromPayload(message.payload, args.fallbackSender),
  };
}

async function gmailGetAttachment(args: {
  readonly accessToken: string;
  readonly gmailMessageId: string;
  readonly attachmentId: string;
  readonly signal: AbortSignal;
}): Promise<Uint8Array | null> {
  const response = await fetch(
    `${GMAIL_API_BASE}/messages/${encodeURIComponent(args.gmailMessageId)}/attachments/${encodeURIComponent(args.attachmentId)}`,
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
      `Failed to read Gmail attachment (HTTP ${response.status})`,
    );
  }
  const attachment = gmailAttachmentResourceSchema.parse(await response.json());
  return new Uint8Array(Buffer.from(attachment.data, "base64url"));
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

function responseDetails(
  row: MailDraftRow,
  details: MailDetails | null,
): MailDetails {
  return (
    details ?? {
      from: row.senderAddress,
      ...(row.senderName ? { fromName: row.senderName } : {}),
      to: [],
      cc: [],
      bcc: [],
      subject: row.subject,
      body: "",
      references: [],
      attachments: [],
    }
  );
}

function responseDraft(args: {
  readonly row: MailDraftRow;
  readonly details: MailDetails | null;
  readonly detailAvailable: boolean;
}): ZeroMailDraft {
  const details = responseDetails(args.row, args.details);
  return zeroMailDraftSchema.parse({
    version: 3,
    provider: "gmail",
    from: details.from,
    fromName: details.fromName,
    to: details.to,
    cc: details.cc,
    bcc: details.bcc,
    subject: details.subject,
    body: details.body,
    bodyHtml: details.bodyHtml,
    inlineImages: details.inlineImages,
    replyTo: details.replyTo,
    inReplyTo: details.inReplyTo,
    references: details.references,
    attachments: details.attachments,
    status: args.row.status,
    detailAvailable: args.detailAvailable,
    gmailDraftId: args.row.gmailDraftId,
    gmailThreadId: args.row.gmailThreadId,
    gmailMessageId: args.row.gmailMessageId,
    sentGmailMessageId: args.row.sentGmailMessageId ?? undefined,
    createdAt: args.row.createdAt.toISOString(),
    updatedAt: args.row.updatedAt.toISOString(),
    sentAt: args.row.sentAt?.toISOString(),
  });
}

async function connectionForRow(args: {
  readonly db: ReadonlyDb;
  readonly snapshot: ConnectorRuntimeSnapshot;
  readonly orgId: string;
  readonly userId: string;
  readonly row: MailDraftRow;
}): Promise<MailConnection | null> {
  const connections = await loadMailConnections({
    db: args.db,
    snapshot: args.snapshot,
    orgId: args.orgId,
    userId: args.userId,
    agentId: args.row.agentId,
  });
  return (
    connections.find((connection) => {
      return connection.connectorId === args.row.connectorId;
    }) ?? null
  );
}

async function accessForRow(args: {
  readonly db: ReadonlyDb;
  readonly writeDb: Db;
  readonly snapshot: ConnectorRuntimeSnapshot;
  readonly orgId: string;
  readonly userId: string;
  readonly row: MailDraftRow;
  readonly signal: AbortSignal;
}): Promise<MailAccess | MailDraftErrorResult> {
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
    ? { ...access, connection }
    : { kind: "conflict", message: access.message };
}

async function persistLinkedDraft(args: {
  readonly db: Db;
  readonly gmail: GmailDraftValue;
  readonly connection: MailConnection;
  readonly threadId: string;
}): Promise<
  | { readonly kind: "created"; readonly mailDraftId: string }
  | {
      readonly kind: "existing";
      readonly mailDraftId: string;
      readonly chatThreadId: string;
    }
> {
  const mailDraftId = randomUUID();
  const createdAt = nowDate();
  const result = await args.db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(mailDrafts)
      .values({
        id: mailDraftId,
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
      })
      .onConflictDoNothing({
        target: [mailDrafts.connectorId, mailDrafts.gmailDraftId],
      })
      .returning({ id: mailDrafts.id });
    if (!inserted) {
      const existing = await loadLinkedDraft({
        db: tx,
        connectorId: args.connection.connectorId,
        gmailDraftId: args.gmail.draftId,
      });
      if (!existing) {
        throw new Error("Linked Gmail draft row could not be loaded");
      }
      return {
        kind: "existing" as const,
        mailDraftId: existing.id,
        chatThreadId: existing.chatThreadId,
      };
    }
    return {
      kind: "created" as const,
      mailDraftId,
    };
  });
  return result;
}

async function markDeleted(args: {
  readonly db: Db;
  readonly row: MailDraftRow;
}): Promise<MailDraftRow> {
  const updatedAt = nowDate();
  await args.db
    .update(mailDrafts)
    .set({ status: "deleted", updatedAt })
    .where(eq(mailDrafts.id, args.row.id));
  return { ...args.row, status: "deleted", updatedAt };
}

async function updateRowFromDraft(args: {
  readonly db: Db;
  readonly row: MailDraftRow;
  readonly gmail: GmailDraftValue;
}): Promise<MailDraftRow> {
  const updatedAt = nowDate();
  await args.db
    .update(mailDrafts)
    .set({
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
    gmailThreadId: args.gmail.threadId,
    gmailMessageId: args.gmail.messageId,
    senderName: args.gmail.details.fromName ?? null,
    senderAddress: args.gmail.details.from,
    subject: args.gmail.details.subject,
    updatedAt,
  };
}

async function getMailDraft(args: {
  readonly db: ReadonlyDb;
  readonly writeDb: Db;
  readonly snapshot: ConnectorRuntimeSnapshot;
  readonly orgId: string;
  readonly userId: string;
  readonly row: MailDraftRow;
  readonly signal: AbortSignal;
}): Promise<ZeroMailDraftMutationResult> {
  if (args.row.status === "deleted") {
    return okResult(
      args.row.id,
      responseDraft({ row: args.row, details: null, detailAvailable: false }),
    );
  }
  const access = await accessForRow(args);
  if (args.row.status === "sent") {
    const stored = okResult(
      args.row.id,
      responseDraft({ row: args.row, details: null, detailAvailable: false }),
    );
    if (access.kind !== "ok" || !args.row.sentGmailMessageId) {
      return stored;
    }
    const sent = await tapError(
      gmailGetMessage({
        accessToken: access.accessToken,
        gmailMessageId: args.row.sentGmailMessageId,
        fallbackSender: {
          address: access.connection.externalEmail,
          name: access.connection.externalUsername,
        },
        signal: args.signal,
      }),
      (error) => {
        L.warn("Failed to enrich sent Gmail draft card", {
          mailDraftId: args.row.id,
          gmailMessageId: args.row.sentGmailMessageId,
          error,
        });
      },
    );
    return sent
      ? okResult(
          args.row.id,
          responseDraft({
            row: args.row,
            details: sent.details,
            detailAvailable: sent.details !== null,
          }),
        )
      : stored;
  }
  if (access.kind !== "ok") {
    return access;
  }
  const gmail = await gmailGetDraft({
    accessToken: access.accessToken,
    gmailDraftId: args.row.gmailDraftId,
    fallbackSender: {
      address: access.connection.externalEmail,
      name: access.connection.externalUsername,
    },
    signal: args.signal,
  });
  if (!gmail) {
    const deleted = await markDeleted({ db: args.writeDb, row: args.row });
    return okResult(
      args.row.id,
      responseDraft({ row: deleted, details: null, detailAvailable: false }),
    );
  }
  const updatedRow = await updateRowFromDraft({
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

async function gmailAttachmentSource(args: {
  readonly accessToken: string;
  readonly row: MailDraftRow;
  readonly partId: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly attachmentId: string;
  readonly messageId: string;
  readonly part: GmailMessagePart;
} | null> {
  if (args.row.status === "deleted") {
    return null;
  }
  if (args.row.status === "sent") {
    if (!args.row.sentGmailMessageId) {
      return null;
    }
    const message = await gmailGetMessageResource({
      accessToken: args.accessToken,
      gmailMessageId: args.row.sentGmailMessageId,
      signal: args.signal,
    });
    const part = message
      ? findAttachmentPart(message.payload, args.partId)
      : null;
    return message && part?.body.attachmentId
      ? {
          attachmentId: part.body.attachmentId,
          messageId: message.id,
          part,
        }
      : null;
  }
  const draft = await gmailGetDraftResource({
    accessToken: args.accessToken,
    gmailDraftId: args.row.gmailDraftId,
    signal: args.signal,
  });
  const part = draft
    ? findAttachmentPart(draft.message.payload, args.partId)
    : null;
  return draft && part?.body.attachmentId
    ? {
        attachmentId: part.body.attachmentId,
        messageId: draft.message.id,
        part,
      }
    : null;
}

export const linkZeroMailDraft$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly threadId: string;
      readonly agentId?: string;
      readonly gmailDraftId: string;
    },
    signal: AbortSignal,
  ): Promise<ZeroMailDraftLinkMutationResult> => {
    const db = get(db$);
    const snapshot = await loadConnectorRuntimeSnapshot(db);
    signal.throwIfAborted();
    const threadAgentId = await ownedThreadAgentId({ db, ...args });
    signal.throwIfAborted();
    if (!threadAgentId || (args.agentId && threadAgentId !== args.agentId)) {
      return { kind: "not_found", message: "Chat thread not found" };
    }
    const connections = (
      await loadMailConnections({
        db,
        snapshot,
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
    const existing = await loadLinkedDraft({
      db,
      connectorId: connection.connectorId,
      gmailDraftId: args.gmailDraftId,
    });
    signal.throwIfAborted();
    if (existing) {
      return existing.chatThreadId === args.threadId
        ? linkResult(existing.id)
        : {
            kind: "conflict",
            message: "This Gmail draft is already linked to another chat",
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
    const gmail = await gmailGetDraft({
      accessToken: access.accessToken,
      gmailDraftId: args.gmailDraftId,
      fallbackSender: {
        address: connection.externalEmail,
        name: connection.externalUsername,
      },
      signal,
    });
    if (!gmail) {
      return { kind: "not_found", message: "Gmail draft not found" };
    }
    const persisted = await persistLinkedDraft({
      db: set(writeDb$),
      gmail,
      connection,
      threadId: args.threadId,
    });
    signal.throwIfAborted();
    if (
      persisted.kind === "existing" &&
      persisted.chatThreadId !== args.threadId
    ) {
      return {
        kind: "conflict",
        message: "This Gmail draft is already linked to another chat",
      };
    }
    return linkResult(persisted.mailDraftId);
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
    const snapshot = await loadConnectorRuntimeSnapshot(db);
    signal.throwIfAborted();
    return await getMailDraft({
      db,
      writeDb: set(writeDb$),
      snapshot,
      orgId: args.orgId,
      userId: args.userId,
      row,
      signal,
    });
  },
);

export const getZeroMailDraftAttachment$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly mailDraftId: string;
      readonly partId: string;
    },
    signal: AbortSignal,
  ): Promise<ZeroMailDraftAttachmentResult> => {
    const db = get(db$);
    const row = await loadOwnedMailDraft({ db, ...args });
    signal.throwIfAborted();
    if (!row) {
      return { kind: "not_found", message: "Mail draft not found" };
    }
    const snapshot = await loadConnectorRuntimeSnapshot(db);
    signal.throwIfAborted();
    const access = await accessForRow({
      db,
      writeDb: set(writeDb$),
      snapshot,
      orgId: args.orgId,
      userId: args.userId,
      row,
      signal,
    });
    if (access.kind !== "ok") {
      return access;
    }
    const source = await gmailAttachmentSource({
      accessToken: access.accessToken,
      row,
      partId: args.partId,
      signal,
    });
    if (!source) {
      return {
        kind: "not_found",
        message: "Mail draft attachment not found",
      };
    }
    const content = await gmailGetAttachment({
      accessToken: access.accessToken,
      gmailMessageId: source.messageId,
      attachmentId: source.attachmentId,
      signal,
    });
    if (!content) {
      return {
        kind: "not_found",
        message: "Mail draft attachment not found",
      };
    }
    return {
      kind: "ok",
      content,
      contentType: source.part.mimeType,
      filename: decodeHeader(source.part.filename || "attachment"),
    };
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
    if (row.status !== "draft") {
      return {
        kind: "conflict",
        message: "Only an active draft can be deleted",
      };
    }
    const snapshot = await loadConnectorRuntimeSnapshot(db);
    signal.throwIfAborted();
    const access = await accessForRow({
      db,
      writeDb: set(writeDb$),
      snapshot,
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
    const deletedDraft = responseDraft({
      row: { ...row, status: "deleted" },
      details: null,
      detailAvailable: false,
    });
    return okResult(row.id, deletedDraft);
  },
);

export const sendZeroMailDraft$ = command(
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
    if (row.status !== "draft") {
      return {
        kind: "conflict",
        message: "This mail draft can no longer be sent",
      };
    }
    const snapshot = await loadConnectorRuntimeSnapshot(db);
    signal.throwIfAborted();
    const access = await accessForRow({
      db,
      writeDb: set(writeDb$),
      snapshot,
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
      fallbackSender: {
        address: access.connection.externalEmail,
        name: access.connection.externalUsername,
      },
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
    const sent = await gmailSendLinkedDraft({
      accessToken: access.accessToken,
      gmailDraftId: row.gmailDraftId,
      signal,
    });
    if (!sent) {
      const deleted = await markDeleted({ db: set(writeDb$), row });
      signal.throwIfAborted();
      return okResult(
        row.id,
        responseDraft({ row: deleted, details: null, detailAvailable: false }),
      );
    }
    const sentAt = nowDate();
    await set(writeDb$)
      .update(mailDrafts)
      .set({
        status: "sent",
        gmailThreadId: sent.threadId,
        gmailMessageId: current.messageId,
        sentGmailMessageId: sent.messageId,
        senderName: current.details.fromName ?? null,
        senderAddress: current.details.from,
        subject: current.details.subject,
        sentAt,
        updatedAt: sentAt,
      })
      .where(eq(mailDrafts.id, row.id));
    signal.throwIfAborted();
    const sentRow: MailDraftRow = {
      ...row,
      status: "sent",
      gmailThreadId: sent.threadId,
      gmailMessageId: current.messageId,
      sentGmailMessageId: sent.messageId,
      senderName: current.details.fromName ?? null,
      senderAddress: current.details.from,
      subject: current.details.subject,
      sentAt,
      updatedAt: sentAt,
    };
    return okResult(
      row.id,
      responseDraft({
        row: sentRow,
        details: current.details,
        detailAvailable: true,
      }),
    );
  },
);
