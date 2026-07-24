import crypto from "node:crypto";

import type { createClerkClient } from "@clerk/backend";
import { emailOutbox } from "@vm0/db/schema/email-outbox";
import { emailSuppressions } from "@vm0/db/schema/email-suppression";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { userCache } from "@vm0/db/schema/user-cache";
import { users } from "@vm0/db/schema/user";
import { command } from "ccstate";
import { and, asc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import { Resend } from "resend";
import { delay } from "signal-timers";
import { Webhook } from "svix";
import { z } from "zod";

import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { now, nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";

type ClerkClient = ReturnType<typeof createClerkClient>;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface EmailOutboxDrainContext {
  readonly currentTimeMs: number;
  readonly signal: AbortSignal;
}

const log = logger("zero:email");
const USER_CACHE_TTL_MS = 900_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1000;
const MAX_OUTBOX_BATCH_SIZE = 120;
const OUTBOX_DRAIN_DELAY_MS = 500;

// Inter-send pacing for Resend rate limits. Overridable so environments
// without a real provider (tests drain a shared outbox backlog) can disable
// the pacing instead of widening timeouts around it.
function outboxDrainDelayMs(): number {
  const configured = optionalEnv("EMAIL_OUTBOX_DRAIN_DELAY_MS");
  if (configured === undefined) {
    return OUTBOX_DRAIN_DELAY_MS;
  }
  const parsed = Number.parseInt(configured, 10);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : OUTBOX_DRAIN_DELAY_MS;
}
const OUTBOX_TTL_MS = 15 * 60 * 1000;
export const CREDIT_LOW_BALANCE_EMAIL_SUBJECT =
  "Your credit balance is running low";

const emailTemplateSchema = z.discriminatedUnion("template", [
  z.object({
    template: z.literal("data-export-ready"),
    props: z.object({
      downloadUrl: z.string(),
      expiresAt: z.string(),
      artifactCount: z.number(),
      unsubscribeUrl: z.string().optional(),
    }),
  }),
  z.object({
    template: z.literal("developer-support"),
    props: z.object({
      title: z.string(),
      description: z.string(),
      reference: z.string(),
      userId: z.string(),
      userEmail: z.string(),
      orgId: z.string(),
      orgName: z.string(),
      runId: z.string(),
      downloadUrl: z.string(),
      expiresAt: z.string(),
    }),
  }),
  z.object({
    template: z.literal("morning-brief"),
    props: z.object({
      dateLabel: z.string(),
      preheader: z.string(),
      headline: z.string().optional(),
      sections: z.array(
        z.object({
          title: z.string(),
          items: z.array(
            z.object({
              title: z.string(),
              detail: z.string().optional(),
              url: z.string().optional(),
            }),
          ),
        }),
      ),
      continueUrl: z.string(),
      manageUrl: z.string(),
    }),
  }),
  z.object({
    template: z.literal("credit-low-balance"),
    props: z.object({
      orgName: z.string(),
      remainingCredits: z.number(),
      thresholdCredits: z.number(),
      billingUrl: z.string(),
      unsubscribeUrl: z.string().optional(),
    }),
  }),
]);

export type EmailTemplate = z.output<typeof emailTemplateSchema>;

const emailAddressesSchema = z.union([z.string(), z.array(z.string())]);
const outboxRowSchema = z.object({
  id: z.string(),
  from_address: z.string(),
  to_addresses: emailAddressesSchema,
  cc_addresses: emailAddressesSchema.nullable(),
  subject: z.string(),
  reply_to: z.string().nullable(),
  headers: z.record(z.string(), z.string()).nullable(),
  template: emailTemplateSchema,
  attempts: z.int(),
});
type OutboxRow = z.output<typeof outboxRowSchema>;

function outboxRowSelection() {
  return {
    id: emailOutbox.id,
    from_address: emailOutbox.fromAddress,
    to_addresses: emailOutbox.toAddresses,
    cc_addresses: emailOutbox.ccAddresses,
    subject: emailOutbox.subject,
    reply_to: emailOutbox.replyTo,
    headers: emailOutbox.headers,
    template: emailOutbox.template,
    attempts: emailOutbox.attempts,
  };
}

function getResendClient(): Resend {
  const apiKey = env("RESEND_API_KEY");
  if (!apiKey) {
    throw new Error("RESEND_API_KEY is not configured");
  }
  return new Resend(apiKey);
}

function apiUrl(): string {
  return env("VM0_API_BACKEND_URL") ?? env("VM0_WEB_URL");
}

function appUrl(): string {
  return env("APP_URL");
}

function getFromDomain(): string {
  const domain = env("RESEND_FROM_DOMAIN");
  if (!domain) {
    throw new Error("RESEND_FROM_DOMAIN is not configured");
  }
  return domain;
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
  return `${appUrl()}/email/unsubscribe?token=${generateUnsubscribeToken(
    userId,
  )}`;
}

export function buildOneClickUnsubscribeUrl(userId: string): string {
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

type MorningBriefEmailTemplate = Extract<
  EmailTemplate,
  { readonly template: "morning-brief" }
>;

const MORNING_BRIEF_LINK_STYLE = "color:#d94801;text-decoration:underline";
const MORNING_BRIEF_FALLBACK_HEADLINE =
  "Good morning. Here's your brief for today.";

function renderMorningBriefTemplate(
  template: MorningBriefEmailTemplate,
): string {
  const sections = template.props.sections
    .map((section) => {
      const items = section.items
        .map((item, index) => {
          const link = item.url
            ? ` (<a href="${escapeHtml(item.url)}" style="${MORNING_BRIEF_LINK_STYLE}">view</a>)`
            : "";
          const detail = item.detail ? ` — ${escapeHtml(item.detail)}` : "";
          const margin = index === section.items.length - 1 ? "0" : "0 0 9px";
          return `<li style="margin:${margin}"><strong>${escapeHtml(
            item.title,
          )}</strong>${link}${detail}</li>`;
        })
        .join("");
      return `<p style="margin:0 0 10px"><strong>${escapeHtml(
        section.title,
      )}</strong> (${section.items.length})</p><ul style="margin:0 0 22px;padding-left:22px">${items}</ul>`;
    })
    .join("");
  const headline = template.props.headline ?? MORNING_BRIEF_FALLBACK_HEADLINE;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"></head><body style="margin:0;padding:0;background-color:#ffffff;color:#202124;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%"><div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;color:transparent;font-size:1px;line-height:1px;mso-hide:all">${escapeHtml(
    template.props.preheader,
  )}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:100%;border-collapse:collapse;background-color:#ffffff"><tr><td align="left" style="padding:24px 20px 40px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;text-align:left"><tr><td><p style="margin:0 0 1em">${escapeHtml(
    headline,
  )}</p><hr style="height:1px;margin:28px 0;border:0;background-color:#e4e6e8">${sections}<p style="margin:0 0 1em">Continue in Zero if you&rsquo;d like to ask a follow-up or turn any item into a task.</p><p style="margin:0"><a href="${escapeHtml(
    template.props.continueUrl,
  )}" style="${MORNING_BRIEF_LINK_STYLE};font-weight:600">Continue in Zero &rarr;</a></p><hr style="height:1px;margin:32px 0 24px;border:0;background-color:#e4e6e8"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr><td width="40" height="40" align="center" valign="middle" bgcolor="#ed4e01" style="width:40px;height:40px;border-radius:10px;color:#ffffff;font-size:17px;font-weight:700;line-height:40px;mso-line-height-rule:exactly">0</td><td valign="middle" style="padding-left:12px;line-height:1.4"><div><strong>Zero</strong></div><div style="margin-top:3px;font-size:12px"><a href="${escapeHtml(
    template.props.continueUrl,
  )}" style="${MORNING_BRIEF_LINK_STYLE}">Open this brief</a> &middot; <a href="${escapeHtml(
    template.props.manageUrl,
  )}" style="${MORNING_BRIEF_LINK_STYLE}">Turn off Morning Brief</a></div></td></tr></table><div style="margin-top:16px;color:#737373;font-size:12px;line-height:1.45">From your &ldquo;Morning Brief&rdquo; routine</div></td></tr></table></td></tr></table></body></html>`;
}

function renderTemplate(template: EmailTemplate): string {
  switch (template.template) {
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
    case "morning-brief": {
      return renderMorningBriefTemplate(template);
    }
    case "credit-low-balance": {
      const remainingCredits =
        template.props.remainingCredits.toLocaleString("en-US");
      const thresholdCredits =
        template.props.thresholdCredits.toLocaleString("en-US");
      const unsubscribe = template.props.unsubscribeUrl
        ? `<p><a href="${escapeHtml(
            template.props.unsubscribeUrl,
          )}">Unsubscribe</a></p>`
        : "";
      return `<main><h1>${CREDIT_LOW_BALANCE_EMAIL_SUBJECT}</h1><p>${escapeHtml(
        template.props.orgName,
      )} has ${escapeHtml(
        remainingCredits,
      )} credits remaining.</p><p>This alert is sent when an org reaches ${escapeHtml(
        thresholdCredits,
      )} credits or less.</p><p><a href="${escapeHtml(
        template.props.billingUrl,
      )}">Manage billing</a></p>${unsubscribe}</main>`;
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

async function processOutboxItem(
  tx: Transaction,
  row: OutboxRow,
  currentTimeMs: number = now(),
): Promise<true> {
  const itemId = row.id;
  const attempts = row.attempts + 1;
  await tx
    .update(emailOutbox)
    .set({ status: "sending", attempts })
    .where(eq(emailOutbox.id, itemId));

  const toAddresses =
    typeof row.to_addresses === "string"
      ? [row.to_addresses]
      : row.to_addresses;
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
    to: row.to_addresses,
    subject: row.subject,
    template: row.template,
    cc: row.cc_addresses ?? undefined,
    replyTo: row.reply_to ?? undefined,
    headers: row.headers ?? undefined,
  });

  if (!result.ok) {
    if (attempts < MAX_ATTEMPTS) {
      const backoffMs = BACKOFF_BASE_MS * 4 ** (attempts - 1);
      await tx
        .update(emailOutbox)
        .set({
          status: "pending",
          lastError: result.error,
          nextRetryAt: new Date(currentTimeMs + backoffMs),
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
  return true;
}

async function drainNextOutboxItem(
  db: Db,
  currentTimeMs: number,
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const currentTime = new Date(currentTimeMs);
    const [selectedRow] = await tx
      .select(outboxRowSelection())
      .from(emailOutbox)
      .where(
        and(
          eq(emailOutbox.status, "pending"),
          or(
            isNull(emailOutbox.nextRetryAt),
            // Keep the Date schema-bound so Drizzle encodes its UTC wall-clock
            // value instead of letting node-postgres apply the process timezone.
            lte(emailOutbox.nextRetryAt, currentTime),
          ),
        ),
      )
      .orderBy(asc(emailOutbox.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });
    const row = selectedRow ? outboxRowSchema.parse(selectedRow) : undefined;
    return row ? await processOutboxItem(tx, row, currentTimeMs) : false;
  });
}

export const drainEmailOutboxBatch$ = command(
  async ({ set }, context: EmailOutboxDrainContext): Promise<number> => {
    const db = set(writeDb$);
    let processed = 0;

    for (let index = 0; index < MAX_OUTBOX_BATCH_SIZE; index++) {
      context.signal.throwIfAborted();
      const hadItem = await drainNextOutboxItem(db, context.currentTimeMs);
      context.signal.throwIfAborted();
      if (!hadItem) {
        break;
      }

      processed++;
      if (index < MAX_OUTBOX_BATCH_SIZE - 1) {
        const delayMs = outboxDrainDelayMs();
        if (delayMs > 0) {
          await delay(delayMs, { signal: context.signal });
        }
      }
    }

    if (processed > 0) {
      log.debug("Drained emails from outbox", { processed });
    }
    return processed;
  },
);

export const cleanupExpiredEmailOutbox$ = command(
  async ({ set }, context: EmailOutboxDrainContext): Promise<number> => {
    const db = set(writeDb$);
    const cutoff = new Date(context.currentTimeMs - OUTBOX_TTL_MS);
    const deleted = await db
      .delete(emailOutbox)
      .where(
        and(
          lt(emailOutbox.createdAt, cutoff),
          or(
            eq(emailOutbox.status, "pending"),
            eq(emailOutbox.status, "failed"),
          ),
        ),
      )
      .returning({ id: emailOutbox.id });
    context.signal.throwIfAborted();

    if (deleted.length > 0) {
      log.debug("Cleaned up expired email outbox items", {
        cleaned: deleted.length,
      });
    }
    return deleted.length;
  },
);

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
      imageUrl: user.imageUrl ?? null,
      cachedAt: nowDate(),
    })
    .onConflictDoUpdate({
      target: userCache.userId,
      set: {
        email,
        name: [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
        imageUrl: user.imageUrl ?? null,
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
      imageUrl: user.imageUrl ?? null,
      cachedAt: nowDate(),
    })
    .onConflictDoUpdate({
      target: userCache.userId,
      set: {
        email: resolvedEmail,
        name: [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
        imageUrl: user.imageUrl ?? null,
        cachedAt: nowDate(),
      },
    });
  return user.id;
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

export async function unsubscribeUser(db: Db, userId: string): Promise<void> {
  await db
    .insert(users)
    .values({ id: userId, emailUnsubscribed: true })
    .onConflictDoUpdate({
      target: users.id,
      set: { emailUnsubscribed: true, updatedAt: nowDate() },
    });
}
