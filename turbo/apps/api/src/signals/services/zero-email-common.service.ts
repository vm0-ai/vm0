import crypto, { randomBytes } from "node:crypto";

import type { createClerkClient } from "@clerk/backend";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { emailOutbox } from "@vm0/db/schema/email-outbox";
import { emailSuppressions } from "@vm0/db/schema/email-suppression";
import { emailThreadSessions } from "@vm0/db/schema/email-thread-session";
import { orgCache } from "@vm0/db/schema/org-cache";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { userCache } from "@vm0/db/schema/user-cache";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { users } from "@vm0/db/schema/user";
import { command, computed, type Computed } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { convert, type FormatCallback } from "html-to-text";
import { Resend } from "resend";
import { Webhook } from "svix";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { now, nowDate } from "../../lib/time";
import { generatePresignedGetUrl, putS3Object } from "../external/s3";
import { writeDb$, type Db } from "../external/db";
import { safeAsync } from "../utils";

type ClerkClient = ReturnType<typeof createClerkClient>;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

const log = logger("zero:email");
const ORG_CACHE_TTL_MS = 60_000;
const USER_CACHE_TTL_MS = 900_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1000;
const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;
const PRESIGNED_URL_EXPIRY = 3600;
const R2_PATH_PREFIX = "email-attachments";

export type HandlerResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errorMessage: string };

interface ReplyRecipients {
  readonly to: readonly string[];
  readonly cc: readonly string[];
}

interface ReceivedEmail {
  readonly from: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly replyTo: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly headers: Record<string, string>;
}

interface ReceivedEmailAttachment {
  readonly id: string;
  readonly filename: string;
  readonly size: number;
  readonly contentType: string;
  readonly contentDisposition: string;
  readonly downloadUrl: string;
}

interface AgentReplyTemplate {
  readonly template: "agent-reply";
  readonly props: {
    readonly agentName: string;
    readonly output: string;
    readonly logsUrl?: string;
    readonly unsubscribeUrl?: string;
  };
}

interface InboundErrorTemplate {
  readonly template: "inbound-error";
  readonly props: {
    readonly errorMessage: string;
    readonly unsubscribeUrl?: string;
  };
}

interface DataExportReadyTemplate {
  readonly template: "data-export-ready";
  readonly props: {
    readonly downloadUrl: string;
    readonly expiresAt: string;
    readonly artifactCount: number;
    readonly unsubscribeUrl?: string;
  };
}

interface DeveloperSupportTemplate {
  readonly template: "developer-support";
  readonly props: {
    readonly title: string;
    readonly description: string;
    readonly reference: string;
    readonly userId: string;
    readonly userEmail: string;
    readonly orgId: string;
    readonly orgName: string;
    readonly runId: string;
    readonly downloadUrl: string;
    readonly expiresAt: string;
  };
}

type EmailTemplate =
  | AgentReplyTemplate
  | InboundErrorTemplate
  | DataExportReadyTemplate
  | DeveloperSupportTemplate;

interface SaveThreadSessionAction {
  readonly action: "save_thread_session";
  readonly userId: string;
  readonly agentId: string;
  readonly agentSessionId: string;
  readonly replyToToken: string;
  readonly orgId?: string;
}

interface UpdateThreadSessionAction {
  readonly action: "update_thread_session";
  readonly sessionId: string;
  readonly agentSessionId?: string;
}

type PostSendAction = SaveThreadSessionAction | UpdateThreadSessionAction;

interface EnqueueEmailOptions {
  readonly from: string;
  readonly to: string | readonly string[];
  readonly subject: string;
  readonly template: EmailTemplate;
  readonly cc?: string | readonly string[];
  readonly replyTo?: string;
  readonly headers?: Record<string, string>;
  readonly threadAction?: PostSendAction;
}

interface OutboxRow extends Record<string, unknown> {
  readonly id: string;
  readonly from_address: string;
  readonly to_addresses: unknown;
  readonly cc_addresses: unknown;
  readonly subject: string;
  readonly reply_to: string | null;
  readonly headers: unknown;
  readonly template: unknown;
  readonly post_send_action: unknown;
  readonly attempts: number;
}

interface OrgIdentity {
  readonly orgId: string;
  readonly slug: string;
  readonly name: string;
  readonly createdBy?: string;
}

function getResendClient(): Resend {
  const apiKey = env("RESEND_API_KEY");
  if (!apiKey) {
    throw new Error("RESEND_API_KEY is not configured");
  }
  return new Resend(apiKey);
}

export function isResendConfigured(): boolean {
  return Boolean(env("RESEND_API_KEY"));
}

export function generateCallbackSecret(): string {
  return randomBytes(32).toString("hex");
}

export function apiUrl(): string {
  return env("VM0_API_URL");
}

function appUrl(): string {
  return env("APP_URL");
}

export function buildIntegrationPrompt(): string {
  return "# Current Integration\nYou are currently running inside: Email";
}

export function parseOrgEmailAddress(toAddress: string): string | null {
  if (isReplyAddress(toAddress)) {
    return null;
  }
  if (toAddress.includes("+") || toAddress.includes("/")) {
    return null;
  }
  const match = toAddress.match(/^([a-z0-9][a-z0-9-]*)@/i);
  return match?.[1] ? match[1].toLowerCase() : null;
}

export function isReplyAddress(toAddress: string): boolean {
  return toAddress.toLowerCase().startsWith("reply+");
}

function emailDomain(address: string): string {
  const atIndex = address.lastIndexOf("@");
  return atIndex === -1 ? "" : address.slice(atIndex + 1).toLowerCase();
}

export function computeReplyRecipients(opts: {
  readonly from: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly replyTo: readonly string[];
  readonly botDomain: string;
}): ReplyRecipients {
  const botDomainLower = opts.botDomain.toLowerCase();
  const isBotAddress = (addr: string): boolean => {
    return emailDomain(addr) === botDomainLower;
  };
  const primaryTarget = opts.replyTo.length > 0 ? opts.replyTo[0]! : opts.from;
  const botInTo = opts.to.some(isBotAddress);
  const otherToRecipients = opts.to.filter((addr) => {
    return !isBotAddress(addr);
  });

  const replyToList =
    botInTo && otherToRecipients.length > 0
      ? [primaryTarget, ...otherToRecipients]
      : [primaryTarget];
  const replyCcList = [...opts.cc];

  const dedup = (list: readonly string[]): string[] => {
    const seen = new Set<string>();
    return list.filter((addr) => {
      const lower = addr.toLowerCase();
      if (seen.has(lower)) {
        return false;
      }
      seen.add(lower);
      return true;
    });
  };

  const to = dedup(
    replyToList.filter((addr) => {
      return !isBotAddress(addr);
    }),
  );
  const toSet = new Set(
    to.map((addr) => {
      return addr.toLowerCase();
    }),
  );
  const cc = dedup(
    replyCcList.filter((addr) => {
      return !isBotAddress(addr) && !toSet.has(addr.toLowerCase());
    }),
  );

  return { to, cc };
}

export function generateReplyToken(sessionId: string): string {
  const hmac = crypto
    .createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(sessionId)
    .digest("hex")
    .slice(0, 16);
  return `${sessionId}.${hmac}`;
}

export function verifyReplyToken(token: string): string | null {
  const dotIndex = token.lastIndexOf(".");
  if (dotIndex === -1) {
    return null;
  }

  const sessionId = token.slice(0, dotIndex);
  const providedHmac = token.slice(dotIndex + 1);
  const expectedHmac = crypto
    .createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(sessionId)
    .digest("hex")
    .slice(0, 16);

  if (providedHmac.length !== expectedHmac.length) {
    return null;
  }
  return crypto.timingSafeEqual(
    Buffer.from(providedHmac),
    Buffer.from(expectedHmac),
  )
    ? sessionId
    : null;
}

export function getFromDomain(): string {
  const domain = env("RESEND_FROM_DOMAIN");
  if (!domain) {
    throw new Error("RESEND_FROM_DOMAIN is not configured");
  }
  return domain;
}

export function buildReplyToAddress(token: string): string {
  return `reply+${token}@${getFromDomain()}`;
}

export function buildFromAddress(localPart: string): string {
  return `Zero <${localPart}@${getFromDomain()}>`;
}

function generateUnsubscribeToken(userId: string): string {
  const hmac = crypto
    .createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(`unsubscribe:${userId}`)
    .digest("hex")
    .slice(0, 32);
  return `${userId}.${hmac}`;
}

export function buildUnsubscribeUrl(userId: string): string {
  return `${apiUrl()}/api/email/unsubscribe?token=${generateUnsubscribeToken(
    userId,
  )}`;
}

export function buildUnsubscribeHeaders(url: string): Record<string, string> {
  return {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

function escapeHtml(value: string): string {
  let escaped = "";
  for (const char of value) {
    switch (char) {
      case "&": {
        escaped += "&amp;";
        break;
      }
      case "<": {
        escaped += "&lt;";
        break;
      }
      case ">": {
        escaped += "&gt;";
        break;
      }
      case '"': {
        escaped += "&quot;";
        break;
      }
      default: {
        escaped += char;
      }
    }
  }
  return escaped;
}

function htmlParagraphs(value: string): string {
  return value
    .split("\n")
    .map((line) => {
      return `<p>${escapeHtml(line)}</p>`;
    })
    .join("");
}

function renderTemplate(template: EmailTemplate): string {
  switch (template.template) {
    case "agent-reply": {
      const logs = template.props.logsUrl
        ? `<p><a href="${escapeHtml(template.props.logsUrl)}">View logs</a></p>`
        : "";
      const unsubscribe = template.props.unsubscribeUrl
        ? `<p><a href="${escapeHtml(
            template.props.unsubscribeUrl,
          )}">Unsubscribe</a></p>`
        : "";
      return `<main><h1>${escapeHtml(
        template.props.agentName,
      )}</h1>${htmlParagraphs(template.props.output)}${logs}${unsubscribe}</main>`;
    }
    case "inbound-error": {
      const unsubscribe = template.props.unsubscribeUrl
        ? `<p><a href="${escapeHtml(
            template.props.unsubscribeUrl,
          )}">Unsubscribe</a></p>`
        : "";
      return `<main><h1>Email delivery failed</h1>${htmlParagraphs(
        template.props.errorMessage,
      )}${unsubscribe}</main>`;
    }
    case "data-export-ready": {
      const unsubscribe = template.props.unsubscribeUrl
        ? `<p><a href="${escapeHtml(
            template.props.unsubscribeUrl,
          )}">Unsubscribe</a></p>`
        : "";
      return `<main><h1>Your data export is ready</h1><p>${template.props.artifactCount} artifacts. Expires ${escapeHtml(
        template.props.expiresAt,
      )}.</p><p><a href="${escapeHtml(
        template.props.downloadUrl,
      )}">Download export</a></p>${unsubscribe}</main>`;
    }
    case "developer-support": {
      return `<main><h1>${escapeHtml(template.props.title)}</h1>${htmlParagraphs(
        template.props.description,
      )}<p>Reference: ${escapeHtml(
        template.props.reference,
      )}</p><p>User: ${escapeHtml(template.props.userEmail)} (${escapeHtml(
        template.props.userId,
      )})</p><p>Org: ${escapeHtml(template.props.orgName)} (${escapeHtml(
        template.props.orgId,
      )})</p><p>Run: ${escapeHtml(
        template.props.runId,
      )}</p><p><a href="${escapeHtml(
        template.props.downloadUrl,
      )}">Download bundle</a></p><p>Expires ${escapeHtml(
        template.props.expiresAt,
      )}</p></main>`;
    }
  }
}

async function sendEmailDirect(options: {
  readonly from: string;
  readonly to: string | readonly string[];
  readonly subject: string;
  readonly template: EmailTemplate;
  readonly cc?: string | readonly string[];
  readonly replyTo?: string;
  readonly headers?: Record<string, string>;
}): Promise<
  | { readonly ok: true; readonly resendId: string }
  | { readonly ok: false; readonly error: string }
> {
  const resend = getResendClient();
  const { data, error } = await resend.emails.send({
    from: options.from,
    to: typeof options.to === "string" ? options.to : [...options.to],
    subject: options.subject,
    html: renderTemplate(options.template),
    cc:
      options.cc === undefined
        ? undefined
        : typeof options.cc === "string"
          ? options.cc
          : [...options.cc],
    replyTo: options.replyTo,
    headers: options.headers,
  });

  if (error || !data) {
    return { ok: false, error: error?.message ?? "unknown" };
  }
  return { ok: true, resendId: data.id };
}

async function getMessageId(resendId: string): Promise<string | null> {
  const { data, error } = await getResendClient().emails.get(resendId);
  if (error || !data) {
    return null;
  }
  return "message_id" in data && typeof data.message_id === "string"
    ? data.message_id
    : null;
}

function normalizeAddresses(raw: unknown): string[] {
  if (typeof raw === "string") {
    return [raw];
  }
  if (Array.isArray(raw)) {
    return raw.filter((value): value is string => {
      return typeof value === "string";
    });
  }
  return [];
}

async function findSuppressedAddress(
  tx: Transaction,
  addresses: readonly string[],
): Promise<string | null> {
  if (addresses.length === 0) {
    return null;
  }
  const lowerAddresses = addresses.map((address) => {
    return address.toLowerCase();
  });
  const rows = await tx
    .select({ emailAddress: emailSuppressions.emailAddress })
    .from(emailSuppressions)
    .where(
      sql`lower(${emailSuppressions.emailAddress}) IN (${sql.join(
        lowerAddresses.map((address) => {
          return sql`${address}`;
        }),
        sql`, `,
      )})`,
    )
    .limit(1);

  const matchedLower = rows[0]?.emailAddress.toLowerCase();
  if (!matchedLower) {
    return null;
  }
  return (
    addresses.find((address) => {
      return address.toLowerCase() === matchedLower;
    }) ?? matchedLower
  );
}

async function saveEmailThreadSession(
  db: Db,
  action: SaveThreadSessionAction,
  lastEmailMessageId: string | null,
): Promise<void> {
  await db.insert(emailThreadSessions).values({
    userId: action.userId,
    agentId: action.agentId,
    agentSessionId: action.agentSessionId,
    lastEmailMessageId,
    replyToToken: action.replyToToken,
    orgId: action.orgId ?? null,
  });
}

async function updateEmailThreadSession(
  db: Db,
  action: UpdateThreadSessionAction,
  lastEmailMessageId: string | null,
): Promise<void> {
  await db
    .update(emailThreadSessions)
    .set({
      ...(action.agentSessionId
        ? { agentSessionId: action.agentSessionId }
        : {}),
      lastEmailMessageId,
      updatedAt: nowDate(),
    })
    .where(eq(emailThreadSessions.id, action.sessionId));
}

async function executePostSendAction(
  db: Db,
  action: PostSendAction,
  resendId: string,
): Promise<void> {
  const messageId = await getMessageId(resendId);
  if (action.action === "save_thread_session") {
    await saveEmailThreadSession(db, action, messageId);
    return;
  }
  await updateEmailThreadSession(db, action, messageId);
}

async function processOutboxItem(
  tx: Transaction,
  row: OutboxRow,
): Promise<true> {
  const itemId = row.id;
  const attempts = row.attempts + 1;
  await tx
    .update(emailOutbox)
    .set({ status: "sending", attempts })
    .where(eq(emailOutbox.id, itemId));

  const toAddresses = normalizeAddresses(row.to_addresses);
  const suppressedAddress = await findSuppressedAddress(tx, toAddresses);
  if (suppressedAddress) {
    await tx
      .update(emailOutbox)
      .set({
        status: "failed",
        lastError: `Recipient address suppressed (${suppressedAddress})`,
      })
      .where(eq(emailOutbox.id, itemId));
    return true;
  }

  const result = await sendEmailDirect({
    from: row.from_address,
    to: row.to_addresses as string | readonly string[],
    subject: row.subject,
    template: row.template as EmailTemplate,
    cc: row.cc_addresses as string | readonly string[] | undefined,
    replyTo: row.reply_to ?? undefined,
    headers: row.headers as Record<string, string> | undefined,
  });

  if (!result.ok) {
    if (attempts < MAX_ATTEMPTS) {
      const backoffMs = BACKOFF_BASE_MS * 4 ** (attempts - 1);
      await tx
        .update(emailOutbox)
        .set({
          status: "pending",
          lastError: result.error,
          nextRetryAt: new Date(now() + backoffMs),
        })
        .where(eq(emailOutbox.id, itemId));
    } else {
      await tx
        .update(emailOutbox)
        .set({ status: "failed", lastError: result.error })
        .where(eq(emailOutbox.id, itemId));
    }
    return true;
  }

  await tx
    .update(emailOutbox)
    .set({ status: "sent", resendId: result.resendId })
    .where(eq(emailOutbox.id, itemId));

  const postSendAction = row.post_send_action as PostSendAction | null;
  if (postSendAction) {
    await executePostSendAction(tx as Db, postSendAction, result.resendId);
  }
  return true;
}

async function drainById(db: Db, itemId: string): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const rows = await tx.execute<OutboxRow>(
      sql`SELECT id, from_address, to_addresses, cc_addresses, subject,
             reply_to, headers, template, post_send_action, attempts
          FROM email_outbox
          WHERE id = ${itemId}
            AND status = 'pending'
          FOR UPDATE SKIP LOCKED`,
    );
    const row = rows.rows[0];
    return row ? await processOutboxItem(tx, row) : false;
  });
}

export const enqueueEmail$ = command(
  async (
    { set },
    options: EnqueueEmailOptions,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const [row] = await db
      .insert(emailOutbox)
      .values({
        fromAddress: options.from,
        toAddresses: options.to,
        ccAddresses: options.cc ?? null,
        subject: options.subject,
        replyTo: options.replyTo ?? null,
        headers: options.headers ?? null,
        template: options.template,
        postSendAction: options.threadAction ?? null,
        status: "pending",
        attempts: 0,
      })
      .returning({ id: emailOutbox.id });
    signal.throwIfAborted();

    if (!row) {
      throw new Error("Failed to insert email outbox row");
    }

    const drainResult = await safeAsync(() => {
      return drainById(db, row.id);
    });
    signal.throwIfAborted();
    if ("error" in drainResult) {
      log.debug("Inline email outbox drain failed", {
        id: row.id,
        error: drainResult.error,
      });
    }
  },
);

export async function getReceivedEmail(
  emailId: string,
): Promise<ReceivedEmail> {
  const { data, error } = await getResendClient().emails.receiving.get(emailId);
  if (error || !data) {
    throw new Error(
      `Failed to get received email: ${error?.message ?? "unknown"}`,
    );
  }
  return {
    from: data.from,
    to: data.to,
    cc: data.cc ?? [],
    replyTo: data.reply_to ?? [],
    subject: data.subject,
    text: data.text ?? "",
    html: data.html ?? "",
    headers: data.headers ?? {},
  };
}

async function getReceivedEmailAttachments(
  emailId: string,
): Promise<readonly ReceivedEmailAttachment[]> {
  const { data, error } =
    await getResendClient().emails.receiving.attachments.list({ emailId });
  if (error || !data) {
    throw new Error(
      `Failed to list email attachments: ${error?.message ?? "unknown"}`,
    );
  }
  return data.data.map((attachment) => {
    return {
      id: attachment.id,
      filename: attachment.filename ?? `attachment-${attachment.id}`,
      size: attachment.size,
      contentType: attachment.content_type,
      contentDisposition: attachment.content_disposition,
      downloadUrl: attachment.download_url,
    };
  });
}

const inlineImageFormatter: FormatCallback = (
  elem,
  _walk,
  builder,
  formatOptions,
) => {
  const attribs = (elem.attribs ?? {}) as Record<string, string>;
  const src = attribs.src ?? "";
  const alt = attribs.alt ?? "";
  if (src.startsWith("data:")) {
    builder.addInline(alt ? `[inline image: ${alt}]` : "[inline image]");
    return;
  }
  const brackets = formatOptions.linkBrackets ?? ["[", "]"];
  const open = brackets ? brackets[0] : "";
  const close = brackets ? brackets[1] : "";
  const srcText = src ? `${open}${src}${close}` : "";
  const text = alt && srcText ? `${alt} ${srcText}` : alt || srcText;
  if (text) {
    builder.addInline(text, { noWordTransform: true });
  }
};

export function extractEmailBody(html: string, text: string): string {
  return html
    ? convert(html, {
        formatters: { inlineImageFormatter },
        selectors: [{ selector: "img", format: "inlineImageFormatter" }],
      })
    : text;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatEmailAttachment(
  attachment: ReceivedEmailAttachment,
  presignedUrl: string,
): string {
  return [
    `[attachment]: ${attachment.filename} (${attachment.contentType}, ${formatSize(
      attachment.size,
    )})`,
    `   URL: ${presignedUrl}`,
    `   To access this file: curl -sS -o /tmp/${attachment.filename} "${presignedUrl}" && read the downloaded file`,
  ].join("\n");
}

function formatEmailAttachmentSkipped(
  attachment: ReceivedEmailAttachment,
  reason: string,
): string {
  return `[attachment]: ${attachment.filename} (${attachment.contentType}, ${formatSize(
    attachment.size,
  )}) - skipped: ${reason}`;
}

function downloadAndUploadEmailAttachment(
  attachment: ReceivedEmailAttachment,
  emailId: string,
): Computed<Promise<string | null>> {
  return computed(async (get): Promise<string | null> => {
    if (attachment.size > MAX_ATTACHMENT_SIZE_BYTES) {
      return null;
    }

    const bufferResult = await safeAsync(async () => {
      const response = await fetch(attachment.downloadUrl);
      if (!response.ok) {
        return null;
      }
      return Buffer.from(await response.arrayBuffer());
    });
    if ("error" in bufferResult || !bufferResult.ok) {
      return null;
    }

    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const key = `${R2_PATH_PREFIX}/${emailId}/${attachment.id}-${attachment.filename}`;
    await get(
      putS3Object(bucket, key, bufferResult.ok, attachment.contentType),
    );
    return await get(
      generatePresignedGetUrl(
        bucket,
        key,
        PRESIGNED_URL_EXPIRY,
        attachment.filename,
      ),
    );
  });
}

export function processEmailAttachments(
  emailId: string,
): Computed<Promise<string>> {
  return computed(async (get): Promise<string> => {
    const attachments = await getReceivedEmailAttachments(emailId);
    if (attachments.length === 0) {
      return "";
    }
    const lines = await Promise.all(
      attachments.map(async (attachment) => {
        if (attachment.size > MAX_ATTACHMENT_SIZE_BYTES) {
          return formatEmailAttachmentSkipped(attachment, "exceeds size limit");
        }
        const url = await get(
          downloadAndUploadEmailAttachment(attachment, emailId),
        );
        return url
          ? formatEmailAttachment(attachment, url)
          : formatEmailAttachmentSkipped(attachment, "download failed");
      }),
    );
    return lines.join("\n\n");
  });
}

type AuthResult =
  | "pass"
  | "fail"
  | "softfail"
  | "neutral"
  | "none"
  | "temperror"
  | "permerror"
  | "policy"
  | null;

interface SenderVerification {
  readonly verified: boolean;
  readonly reason: string;
  readonly details: {
    readonly dmarc: AuthResult;
    readonly dkim: AuthResult;
    readonly spf: AuthResult;
  };
}

const AUTH_RESULT_VALUES = [
  "pass",
  "fail",
  "softfail",
  "neutral",
  "none",
  "temperror",
  "permerror",
  "policy",
] as const;

function parseAuthResult(value: string | undefined): AuthResult {
  return value && (AUTH_RESULT_VALUES as readonly string[]).includes(value)
    ? (value as AuthResult)
    : null;
}

export function verifySenderAuthenticity(
  headers: Record<string, string>,
): SenderVerification {
  const headerKey = Object.keys(headers).find((key) => {
    return key.toLowerCase() === "authentication-results";
  });
  if (!headerKey) {
    return {
      verified: false,
      reason: "no authentication-results header found",
      details: { dmarc: null, dkim: null, spf: null },
    };
  }

  const lower = headers[headerKey]!.toLowerCase();
  const details = {
    dmarc: parseAuthResult(lower.match(/dmarc\s*=\s*(\w+)/)?.[1]),
    dkim: parseAuthResult(lower.match(/dkim\s*=\s*(\w+)/)?.[1]),
    spf: parseAuthResult(lower.match(/spf\s*=\s*(\w+)/)?.[1]),
  };
  return details.dmarc === "pass"
    ? { verified: true, reason: "dmarc=pass", details }
    : {
        verified: false,
        reason: `dmarc=${details.dmarc ?? "missing"}`,
        details,
      };
}

export function getSvixHeaders(headers: Headers): {
  readonly "svix-id": string;
  readonly "svix-timestamp": string;
  readonly "svix-signature": string;
} | null {
  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signature = headers.get("svix-signature");
  return id && timestamp && signature
    ? {
        "svix-id": id,
        "svix-timestamp": timestamp,
        "svix-signature": signature,
      }
    : null;
}

export function verifyResendWebhook(
  payload: string,
  headers: {
    readonly "svix-id": string;
    readonly "svix-timestamp": string;
    readonly "svix-signature": string;
  },
): unknown {
  const secret = env("RESEND_WEBHOOK_SECRET");
  if (!secret) {
    throw new Error("RESEND_WEBHOOK_SECRET is not configured");
  }
  return new Webhook(secret).verify(payload, headers);
}

export async function getOrgNameAndSlug(
  db: Db,
  clerk: ClerkClient,
  orgId: string,
): Promise<OrgIdentity> {
  const [cached] = await db
    .select()
    .from(orgCache)
    .where(eq(orgCache.orgId, orgId))
    .limit(1);
  if (cached && now() - cached.cachedAt.getTime() < ORG_CACHE_TTL_MS) {
    return {
      orgId,
      slug: cached.slug,
      name: cached.name,
      createdBy: cached.createdBy ?? undefined,
    };
  }

  const org = await clerk.organizations.getOrganization({
    organizationId: orgId,
  });
  if (!org.slug) {
    throw new Error(`Clerk organization ${orgId} has no slug`);
  }
  await db
    .insert(orgCache)
    .values({
      orgId,
      slug: org.slug,
      name: org.name,
      createdBy: org.createdBy ?? null,
      cachedAt: nowDate(),
    })
    .onConflictDoUpdate({
      target: orgCache.orgId,
      set: {
        slug: org.slug,
        name: org.name,
        createdBy: org.createdBy ?? null,
        cachedAt: nowDate(),
      },
    });
  return {
    orgId,
    slug: org.slug,
    name: org.name,
    createdBy: org.createdBy ?? undefined,
  };
}

export async function getOrgIdBySlug(
  db: Db,
  clerk: ClerkClient,
  slug: string,
): Promise<string | null> {
  const [cached] = await db
    .select()
    .from(orgCache)
    .where(eq(orgCache.slug, slug))
    .limit(1);
  if (cached && now() - cached.cachedAt.getTime() < ORG_CACHE_TTL_MS) {
    return cached.orgId;
  }

  const orgResult = await safeAsync(() => {
    return clerk.organizations.getOrganization({ slug });
  });
  if ("error" in orgResult) {
    return null;
  }
  const org = orgResult.ok;
  if (!org.slug) {
    return null;
  }
  await db
    .insert(orgCache)
    .values({
      orgId: org.id,
      slug: org.slug,
      name: org.name,
      createdBy: org.createdBy ?? null,
      cachedAt: nowDate(),
    })
    .onConflictDoUpdate({
      target: orgCache.orgId,
      set: {
        slug: org.slug,
        name: org.name,
        createdBy: org.createdBy ?? null,
        cachedAt: nowDate(),
      },
    });
  return org.id;
}

export async function getUserEmail(
  db: Db,
  clerk: ClerkClient,
  userId: string,
): Promise<string | null> {
  const [cached] = await db
    .select()
    .from(userCache)
    .where(eq(userCache.userId, userId))
    .limit(1);
  if (cached && now() - cached.cachedAt.getTime() < USER_CACHE_TTL_MS) {
    return cached.email;
  }

  const usersResponse = await clerk.users.getUserList({ userId: [userId] });
  const user = usersResponse.data[0];
  if (!user) {
    return null;
  }
  const email =
    user?.emailAddresses.find((entry) => {
      return entry.id === user.primaryEmailAddressId;
    })?.emailAddress ?? user?.emailAddresses[0]?.emailAddress;
  if (!email) {
    return null;
  }

  await db
    .insert(userCache)
    .values({
      userId,
      email,
      name: [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
      cachedAt: nowDate(),
    })
    .onConflictDoUpdate({
      target: userCache.userId,
      set: {
        email,
        name: [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
        cachedAt: nowDate(),
      },
    });
  return email;
}

export async function getUserIdByEmail(
  db: Db,
  clerk: ClerkClient,
  email: string,
): Promise<string | null> {
  const [cached] = await db
    .select()
    .from(userCache)
    .where(eq(userCache.email, email))
    .limit(1);
  if (cached && now() - cached.cachedAt.getTime() < USER_CACHE_TTL_MS) {
    return cached.userId;
  }

  const usersResponse = await clerk.users.getUserList({
    emailAddress: [email],
  });
  const user = usersResponse.data[0];
  if (!user) {
    return null;
  }
  const resolvedEmail =
    user.emailAddresses.find((entry) => {
      return entry.id === user.primaryEmailAddressId;
    })?.emailAddress ??
    user.emailAddresses[0]?.emailAddress ??
    email;

  await db
    .insert(userCache)
    .values({
      userId: user.id,
      email: resolvedEmail,
      name: [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
      cachedAt: nowDate(),
    })
    .onConflictDoUpdate({
      target: userCache.userId,
      set: {
        email: resolvedEmail,
        name: [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
        cachedAt: nowDate(),
      },
    });
  return user.id;
}

export async function userHasOrgMembership(
  db: Db,
  clerk: ClerkClient,
  orgId: string,
  userId: string,
): Promise<boolean> {
  const [cached] = await db
    .select({ role: orgMembersCache.role, cachedAt: orgMembersCache.cachedAt })
    .from(orgMembersCache)
    .where(
      and(eq(orgMembersCache.orgId, orgId), eq(orgMembersCache.userId, userId)),
    )
    .limit(1);
  if (cached && now() - cached.cachedAt.getTime() < ORG_CACHE_TTL_MS) {
    return true;
  }

  const memberships = await clerk.users.getOrganizationMembershipList({
    userId,
    limit: 100,
  });
  const membership = memberships.data.find((entry) => {
    return entry.organization.id === orgId;
  });
  if (!membership) {
    return false;
  }
  await db
    .insert(orgMembersCache)
    .values({
      orgId,
      userId,
      role: membership.role === "org:admin" ? "admin" : "member",
      cachedAt: nowDate(),
    })
    .onConflictDoUpdate({
      target: [orgMembersCache.orgId, orgMembersCache.userId],
      set: {
        role: membership.role === "org:admin" ? "admin" : "member",
        cachedAt: nowDate(),
      },
    });
  return true;
}

export async function resolveDefaultAgent(
  db: Db,
  orgId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ defaultAgentId: orgMetadata.defaultAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return row?.defaultAgentId ?? null;
}

export async function resolveEmailAuditLogsUrl(
  db: Db,
  opts: {
    readonly orgId: string;
    readonly userId: string;
    readonly runId: string;
  },
): Promise<string | undefined> {
  const [row] = await db
    .select({ switches: userFeatureSwitches.switches })
    .from(userFeatureSwitches)
    .where(
      and(
        eq(userFeatureSwitches.orgId, opts.orgId),
        eq(userFeatureSwitches.userId, opts.userId),
      ),
    )
    .limit(1);
  const enabled = isFeatureEnabled(FeatureSwitchKey.AuditLink, {
    orgId: opts.orgId,
    userId: opts.userId,
    overrides: row?.switches ?? {},
  });
  return enabled
    ? `${appUrl()}/activities/${encodeURIComponent(opts.runId)}`
    : undefined;
}

export async function unsubscribeUser(db: Db, userId: string): Promise<void> {
  await db
    .insert(users)
    .values({ id: userId, emailUnsubscribed: true })
    .onConflictDoUpdate({
      target: users.id,
      set: { emailUnsubscribed: true, updatedAt: nowDate() },
    });
}

export function completedOutputText(
  status: "completed" | "failed" | "progress",
  rawOutput: string | null | undefined,
  error: string | undefined,
): string {
  if (status !== "completed") {
    return error ?? "The agent run failed.";
  }
  if (!rawOutput) {
    return "Task completed successfully.";
  }
  return rawOutput.length > 2000 ? `${rawOutput.slice(0, 2000)}...` : rawOutput;
}

export function extractAgentSessionId(result: unknown): string | undefined {
  return result &&
    typeof result === "object" &&
    "agentSessionId" in result &&
    typeof result.agentSessionId === "string"
    ? result.agentSessionId
    : undefined;
}
