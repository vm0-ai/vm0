import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  zeroMailDraftSchema,
  type ZeroMailDraft,
  type ZeroMailProvider,
} from "@vm0/api-contracts/contracts/zero-mail";
import { refreshGoogleToken } from "@vm0/connectors/auth-providers/oauth/google";
import { refreshMicrosoftToken } from "@vm0/connectors/auth-providers/oauth/microsoft";
import { hasRequiredConnectorAuthMethodScopes } from "@vm0/connectors/connector-utils";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { connectors } from "@vm0/db/schema/connector";
import { mailDrafts } from "@vm0/db/schema/mail-draft";
import { secrets } from "@vm0/db/schema/secret";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { z } from "zod";

import { optionalEnv } from "../../lib/env";
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
const MAIL_SEND_TIMEOUT_MS = 60_000;
const oauthScopesSchema = z.array(z.string());

const MAIL_PROVIDER_CONFIG = {
  gmail: {
    connectorType: "gmail",
    accessTokenSecret: "GMAIL_ACCESS_TOKEN",
    refreshTokenSecret: "GMAIL_REFRESH_TOKEN",
    clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
    clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
  },
  outlook: {
    connectorType: "outlook-mail",
    accessTokenSecret: "OUTLOOK_MAIL_ACCESS_TOKEN",
    refreshTokenSecret: "OUTLOOK_MAIL_REFRESH_TOKEN",
    clientIdEnv: "MICROSOFT_OAUTH_CLIENT_ID",
    clientSecretEnv: "MICROSOFT_OAUTH_CLIENT_SECRET",
  },
} as const;

interface MailConnection {
  readonly connectorId: string;
  readonly connectorType: "gmail" | "outlook-mail";
  readonly externalEmail: string;
  readonly needsReconnect: boolean;
  readonly provider: ZeroMailProvider;
  readonly scopesReady: boolean;
  readonly tokenExpiresAt: Date | null;
}

interface MailDraftResult {
  readonly kind: "ok";
  readonly mailDraftId: string;
  readonly mailDraft: ZeroMailDraft;
}

interface MailDraftErrorResult {
  readonly kind: "not_found" | "conflict";
  readonly message: string;
}

export type ZeroMailDraftMutationResult =
  | MailDraftResult
  | MailDraftErrorResult;

interface StoredMailDraftRow {
  readonly agentId: string;
  readonly mailDraft: ZeroMailDraft;
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

type MailDeliveryResult =
  | { readonly kind: "sent" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "delivery_unknown"; readonly message: string };

function providerFromConnectorType(
  connectorType: "gmail" | "outlook-mail",
): ZeroMailProvider {
  return connectorType === "gmail" ? "gmail" : "outlook";
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
      connectorType: connectors.type,
      authMethod: connectors.authMethod,
      externalEmail: connectors.externalEmail,
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
        inArray(userConnectors.connectorType, ["gmail", "outlook-mail"]),
      ),
    );

  return rows.flatMap((row): MailConnection[] => {
    if (
      (row.connectorType !== "gmail" && row.connectorType !== "outlook-mail") ||
      !row.externalEmail
    ) {
      return [];
    }
    return [
      {
        connectorId: row.connectorId,
        connectorType: row.connectorType,
        externalEmail: row.externalEmail,
        needsReconnect: row.needsReconnect,
        provider: providerFromConnectorType(row.connectorType),
        scopesReady: hasRequiredConnectorAuthMethodScopes(
          row.connectorType,
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

async function loadOwnedMailDraft(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
  readonly mailDraftId: string;
}): Promise<StoredMailDraftRow | null> {
  const [row] = await args.db
    .select({
      agentId: chatThreads.agentComposeId,
      mailDraft: mailDrafts.draft,
    })
    .from(mailDrafts)
    .innerJoin(chatMessages, eq(chatMessages.mailDraftId, mailDrafts.id))
    .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.chatThreadId))
    .innerJoin(agentComposes, eq(agentComposes.id, chatThreads.agentComposeId))
    .where(
      and(
        eq(mailDrafts.id, args.mailDraftId),
        eq(chatThreads.userId, args.userId),
        eq(agentComposes.orgId, args.orgId),
      ),
    )
    .limit(1);
  if (!row?.mailDraft) {
    return null;
  }
  return {
    agentId: row.agentId,
    mailDraft: zeroMailDraftSchema.parse(row.mailDraft),
  };
}

async function persistMailDraft(args: {
  readonly db: Db;
  readonly mailDraft: ZeroMailDraft;
  readonly threadId: string;
  readonly userId: string;
}): Promise<ZeroMailDraftMutationResult> {
  const created = await args.db.transaction(async (tx) => {
    const mailDraftId = randomUUID();
    const message = await insertChatMessage(tx, {
      chatThreadId: args.threadId,
      role: "assistant",
      content: null,
      mailDraftId,
    });
    if (!message) {
      throw new Error("Mail draft message insert did not return an id");
    }
    await tx
      .insert(mailDrafts)
      .values({ id: mailDraftId, draft: args.mailDraft });
    return { mailDraftId, messageId: message.id };
  });
  await tapError(
    publishUserSignal(
      [args.userId],
      `chatThreadMessageCreated:${args.threadId}`,
    ),
    (error) => {
      L.warn("Failed to publish mail draft creation", {
        threadId: args.threadId,
        messageId: created.messageId,
        error,
      });
    },
  );
  return {
    kind: "ok",
    mailDraftId: created.mailDraftId,
    mailDraft: args.mailDraft,
  };
}

function draftWithFields(
  current: ZeroMailDraft,
  fields: {
    readonly to: readonly string[];
    readonly subject: string;
    readonly body: string;
  },
  updatedAt: string,
): ZeroMailDraft {
  return {
    ...current,
    to: [...fields.to],
    subject: fields.subject,
    body: fields.body,
    updatedAt,
    error: undefined,
  };
}

async function replaceEditableDraft(args: {
  readonly db: Db;
  readonly mailDraftId: string;
  readonly mailDraft: ZeroMailDraft;
}): Promise<ZeroMailDraft | null> {
  const [updated] = await args.db
    .update(mailDrafts)
    .set({ draft: args.mailDraft })
    .where(
      and(
        eq(mailDrafts.id, args.mailDraftId),
        sql<boolean>`${mailDrafts.draft}->>'status' IN ('draft', 'failed')`,
      ),
    )
    .returning({ mailDraft: mailDrafts.draft });
  return updated ? zeroMailDraftSchema.parse(updated.mailDraft) : null;
}

async function replaceSendingDraft(args: {
  readonly db: Db;
  readonly mailDraftId: string;
  readonly mailDraft: ZeroMailDraft;
}): Promise<ZeroMailDraft> {
  const [updated] = await args.db
    .update(mailDrafts)
    .set({ draft: args.mailDraft })
    .where(
      and(
        eq(mailDrafts.id, args.mailDraftId),
        sql<boolean>`${mailDrafts.draft}->>'status' = 'sending'`,
      ),
    )
    .returning({ mailDraft: mailDrafts.draft });
  if (!updated) {
    throw new Error("Mail draft sending state changed unexpectedly");
  }
  return zeroMailDraftSchema.parse(updated.mailDraft);
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
  readonly accessTokenSecret: string;
  readonly refreshTokenSecret: string;
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
          args.accessTokenSecret,
          args.refreshTokenSecret,
        ]),
      ),
    );
  const values = new Map<string, string>();
  for (const row of rows) {
    values.set(row.name, await decryptStoredSecretValue(row.encryptedValue));
  }
  return {
    accessToken: values.get(args.accessTokenSecret) ?? null,
    refreshToken: values.get(args.refreshTokenSecret) ?? null,
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
  const config = MAIL_PROVIDER_CONFIG[args.connection.provider];
  const clientId = optionalEnv(config.clientIdEnv);
  const clientSecret = optionalEnv(config.clientSecretEnv);
  if (!clientId || !clientSecret) {
    return { kind: "error", message: "Mail OAuth is not configured" };
  }

  const refreshResult = await settleIncludingAbort(
    args.connection.provider === "gmail"
      ? refreshGoogleToken(
          "gmail",
          clientId,
          clientSecret,
          args.refreshToken,
          args.signal,
        )
      : refreshMicrosoftToken(
          "outlook-mail",
          clientId,
          clientSecret,
          args.refreshToken,
          args.signal,
        ),
  );
  if (!refreshResult.ok) {
    L.warn("Mail access token refresh failed", {
      provider: args.connection.provider,
      connectorId: args.connection.connectorId,
      error: refreshResult.error,
    });
    return {
      kind: "error",
      message: `Reconnect ${args.connection.provider === "gmail" ? "Gmail" : "Outlook Mail"} before sending`,
    };
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
      type: args.connection.connectorType,
    });
    await upsertConnectorSecret({
      db: tx,
      orgId: args.orgId,
      userId: args.userId,
      name: config.accessTokenSecret,
      value: refreshed.accessToken,
    });
    await upsertConnectorSecret({
      db: tx,
      orgId: args.orgId,
      userId: args.userId,
      name: config.refreshTokenSecret,
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
  const config = MAIL_PROVIDER_CONFIG[args.connection.provider];
  if (args.connection.needsReconnect || !args.connection.scopesReady) {
    return {
      kind: "error",
      message: `Reconnect ${args.connection.provider === "gmail" ? "Gmail" : "Outlook Mail"} before sending`,
    };
  }
  const tokens = await loadConnectorTokens({
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    accessTokenSecret: config.accessTokenSecret,
    refreshTokenSecret: config.refreshTokenSecret,
  });
  const expiresAt = args.connection.tokenExpiresAt?.getTime() ?? 0;
  if (
    tokens.accessToken &&
    (expiresAt === 0 || expiresAt > nowDate().getTime() + TOKEN_REFRESH_SKEW_MS)
  ) {
    return { kind: "ok", accessToken: tokens.accessToken };
  }
  if (!tokens.refreshToken) {
    return {
      kind: "error",
      message: `Reconnect ${args.connection.provider === "gmail" ? "Gmail" : "Outlook Mail"} before sending`,
    };
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

function gmailRawMessage(draft: ZeroMailDraft): string {
  const encodedSubject = Buffer.from(draft.subject, "utf8").toString("base64");
  const encodedBody = Buffer.from(draft.body, "utf8")
    .toString("base64")
    .match(/.{1,76}/g)
    ?.join("\r\n");
  const mime = [
    `From: ${draft.from}`,
    `To: ${draft.to.join(", ")}`,
    `Subject: =?UTF-8?B?${encodedSubject}?=`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    encodedBody ?? "",
  ].join("\r\n");
  return Buffer.from(mime, "utf8").toString("base64url");
}

async function deliverMail(args: {
  readonly accessToken: string;
  readonly draft: ZeroMailDraft;
  readonly signal: AbortSignal;
}): Promise<MailDeliveryResult> {
  const deliveryResult = await settleIncludingAbort(
    args.draft.provider === "gmail"
      ? fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
          method: "POST",
          signal: args.signal,
          headers: {
            Authorization: `Bearer ${args.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ raw: gmailRawMessage(args.draft) }),
        })
      : fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
          method: "POST",
          signal: args.signal,
          headers: {
            Authorization: `Bearer ${args.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message: {
              subject: args.draft.subject,
              body: { contentType: "Text", content: args.draft.body },
              toRecipients: args.draft.to.map((address) => {
                return { emailAddress: { address } };
              }),
            },
            saveToSentItems: true,
          }),
        }),
  );
  if (!deliveryResult.ok) {
    L.warn("Mail delivery result is unknown", {
      provider: args.draft.provider,
      error: deliveryResult.error,
    });
    return {
      kind: "delivery_unknown",
      message:
        "The provider response could not be confirmed. Check Sent Mail before trying again.",
    };
  }
  const response = deliveryResult.value;

  const accepted =
    args.draft.provider === "gmail" ? response.ok : response.status === 202;
  if (accepted) {
    return { kind: "sent" };
  }
  return {
    kind: "failed",
    message: `The mail provider rejected the request (HTTP ${response.status})`,
  };
}

export const createZeroMailDraft$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly threadId: string;
      readonly agentId: string;
      readonly provider?: ZeroMailProvider;
      readonly to: readonly string[];
      readonly subject: string;
      readonly body: string;
    },
    signal: AbortSignal,
  ): Promise<ZeroMailDraftMutationResult> => {
    const db = get(db$);
    const threadAgentId = await ownedThreadAgentId({
      db,
      orgId: args.orgId,
      userId: args.userId,
      threadId: args.threadId,
    });
    signal.throwIfAborted();
    if (!threadAgentId || threadAgentId !== args.agentId) {
      return { kind: "not_found", message: "Chat thread not found" };
    }

    const connections = (
      await loadMailConnections({
        db,
        orgId: args.orgId,
        userId: args.userId,
        agentId: args.agentId,
      })
    ).filter((connection) => {
      return !connection.needsReconnect && connection.scopesReady;
    });
    signal.throwIfAborted();
    const selected = args.provider
      ? connections.find((connection) => {
          return connection.provider === args.provider;
        })
      : connections.length === 1
        ? connections[0]
        : undefined;
    if (!selected) {
      if (!args.provider && connections.length > 1) {
        return {
          kind: "conflict",
          message:
            "Both Gmail and Outlook Mail are available; pass --provider gmail or --provider outlook",
        };
      }
      return {
        kind: "conflict",
        message: args.provider
          ? `${args.provider === "gmail" ? "Gmail" : "Outlook Mail"} is not connected and authorized for this agent`
          : "Connect and authorize Gmail or Outlook Mail for this agent first",
      };
    }

    const timestamp = nowDate().toISOString();
    const mailDraft = zeroMailDraftSchema.parse({
      version: 1,
      provider: selected.provider,
      from: selected.externalEmail,
      to: [...args.to],
      subject: args.subject,
      body: args.body,
      status: "draft",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return await persistMailDraft({
      db: set(writeDb$),
      mailDraft,
      threadId: args.threadId,
      userId: args.userId,
    });
  },
);

export const getZeroMailDraft$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly mailDraftId: string;
    },
  ): Promise<ZeroMailDraftMutationResult> => {
    const stored = await loadOwnedMailDraft({ db: get(db$), ...args });
    if (!stored) {
      return { kind: "not_found", message: "Mail draft not found" };
    }
    return {
      kind: "ok",
      mailDraftId: args.mailDraftId,
      mailDraft: stored.mailDraft,
    };
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
      readonly subject: string;
      readonly body: string;
    },
  ): Promise<ZeroMailDraftMutationResult> => {
    const db = get(db$);
    const stored = await loadOwnedMailDraft({ db, ...args });
    if (!stored) {
      return { kind: "not_found", message: "Mail draft not found" };
    }
    const mailDraft = draftWithFields(
      stored.mailDraft,
      args,
      nowDate().toISOString(),
    );
    const updated = await replaceEditableDraft({
      db: set(writeDb$),
      mailDraftId: args.mailDraftId,
      mailDraft,
    });
    if (!updated) {
      return {
        kind: "conflict",
        message: "This mail draft can no longer be edited",
      };
    }
    return { kind: "ok", mailDraftId: args.mailDraftId, mailDraft: updated };
  },
);

export const cancelZeroMailDraft$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly mailDraftId: string;
    },
  ): Promise<ZeroMailDraftMutationResult> => {
    const db = get(db$);
    const stored = await loadOwnedMailDraft({ db, ...args });
    if (!stored) {
      return { kind: "not_found", message: "Mail draft not found" };
    }
    const updatedAt = nowDate().toISOString();
    const updated = await replaceEditableDraft({
      db: set(writeDb$),
      mailDraftId: args.mailDraftId,
      mailDraft: {
        ...stored.mailDraft,
        status: "cancelled",
        updatedAt,
        error: undefined,
      },
    });
    if (!updated) {
      return {
        kind: "conflict",
        message: "This mail draft can no longer be cancelled",
      };
    }
    return { kind: "ok", mailDraftId: args.mailDraftId, mailDraft: updated };
  },
);

export const sendZeroMailDraft$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly mailDraftId: string;
      readonly to: readonly string[];
      readonly subject: string;
      readonly body: string;
    },
  ): Promise<ZeroMailDraftMutationResult> => {
    const db = get(db$);
    const stored = await loadOwnedMailDraft({ db, ...args });
    if (!stored) {
      return { kind: "not_found", message: "Mail draft not found" };
    }

    const claimedAt = nowDate().toISOString();
    const claimed = await replaceEditableDraft({
      db: set(writeDb$),
      mailDraftId: args.mailDraftId,
      mailDraft: {
        ...draftWithFields(stored.mailDraft, args, claimedAt),
        status: "sending",
      },
    });
    if (!claimed) {
      return {
        kind: "conflict",
        message: "This mail draft has already been sent or is being sent",
      };
    }
    const providerSignal = AbortSignal.timeout(MAIL_SEND_TIMEOUT_MS);
    const connections = await loadMailConnections({
      db,
      orgId: args.orgId,
      userId: args.userId,
      agentId: stored.agentId,
    });
    const connection = connections.find((candidate) => {
      return candidate.provider === claimed.provider;
    });
    let delivery: MailDeliveryResult;
    if (!connection || connection.externalEmail !== claimed.from) {
      delivery = {
        kind: "failed",
        message:
          "The authorized sender changed. Create a new mail draft before sending.",
      };
    } else {
      const access = await resolveMailAccessToken({
        connection,
        db,
        orgId: args.orgId,
        userId: args.userId,
        signal: providerSignal,
        writeDb: set(writeDb$),
      });
      delivery =
        access.kind === "ok"
          ? await deliverMail({
              accessToken: access.accessToken,
              draft: claimed,
              signal: providerSignal,
            })
          : { kind: "failed", message: access.message };
    }

    const completedAt = nowDate().toISOString();
    const completed: ZeroMailDraft =
      delivery.kind === "sent"
        ? {
            ...claimed,
            status: "sent",
            updatedAt: completedAt,
            sentAt: completedAt,
            error: undefined,
          }
        : {
            ...claimed,
            status: delivery.kind,
            updatedAt: completedAt,
            error: delivery.message,
          };
    const updated = await replaceSendingDraft({
      db: set(writeDb$),
      mailDraftId: args.mailDraftId,
      mailDraft: completed,
    });
    return { kind: "ok", mailDraftId: args.mailDraftId, mailDraft: updated };
  },
);
