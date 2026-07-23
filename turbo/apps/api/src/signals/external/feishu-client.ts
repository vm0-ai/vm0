import { z } from "zod";
import { eq } from "drizzle-orm";
import { feishuOrgInstallations } from "@vm0/db/schema/feishu-org-installation";

import type { Db } from "./db";
import { nowDate } from "./time";
import {
  decryptPersistentSecretValue,
  encryptPersistentSecretValue,
} from "../services/crypto.utils";

const FEISHU_API_ORIGIN = "https://open.feishu.cn";
const TOKEN_REFRESH_WINDOW_MS = 3 * 60 * 1000;

const tenantAccessTokenResponseSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  tenant_access_token: z.string().optional(),
  expire: z.number().optional(),
});

const feishuBotInfoSchema = z.object({
  open_id: z.string().optional(),
  app_name: z.string().optional(),
  avatar_url: z.string().optional(),
});

const feishuBotInfoResponseSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  bot: feishuBotInfoSchema.optional(),
  data: z.object({ bot: feishuBotInfoSchema.optional() }).optional(),
});

const feishuOAuthTokenResponseSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  access_token: z.string().optional(),
});

const feishuUserInfoResponseSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: z
    .object({
      name: z.string().optional(),
      open_id: z.string().optional(),
      tenant_key: z.string().optional(),
    })
    .optional(),
});

const feishuResponseSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
});

const feishuMessageResponseSchema = feishuResponseSchema.extend({
  data: z
    .object({
      message_id: z.string().optional(),
      chat_id: z.string().optional(),
    })
    .optional(),
});

const feishuReactionResponseSchema = feishuResponseSchema.extend({
  data: z.object({ reaction_id: z.string().optional() }).optional(),
});

const feishuHistoryMessageSchema = z.object({
  message_id: z.string(),
  root_id: z.string().optional(),
  parent_id: z.string().optional(),
  thread_id: z.string().optional(),
  msg_type: z.string(),
  create_time: z.string().optional(),
  deleted: z.boolean().optional(),
  chat_id: z.string().optional(),
  sender: z
    .object({
      id: z.string().optional(),
      id_type: z.string().optional(),
      sender_type: z.string().optional(),
      sender_name: z.string().optional(),
    })
    .optional(),
  body: z.object({ content: z.string().optional() }).optional(),
  mentions: z
    .array(
      z.object({
        key: z.string().optional(),
        id: z.string().optional(),
        name: z.string().optional(),
      }),
    )
    .optional(),
});

const feishuMessageHistoryResponseSchema = feishuResponseSchema.extend({
  data: z
    .object({
      items: z.array(feishuHistoryMessageSchema).optional(),
      has_more: z.boolean().optional(),
      page_token: z.string().optional(),
    })
    .optional(),
});

interface FeishuTenantAccessToken {
  readonly token: string;
  readonly expiresInSeconds: number;
}

interface FeishuBotInfo {
  readonly openId: string;
  readonly name: string;
  readonly avatarUrl: string | null;
}

export interface FeishuOutboundMessage {
  readonly msgType: "interactive" | "text";
  readonly content: Readonly<Record<string, unknown>>;
}

interface FeishuSentMessage {
  readonly messageId: string;
  readonly chatId: string | null;
}

export type FeishuHistoryMessage = z.infer<typeof feishuHistoryMessageSchema>;

export interface FeishuUserInfo {
  readonly name: string | null;
  readonly openId: string;
  readonly tenantKey: string | null;
}

export class FeishuApiError extends Error {
  constructor(
    message: string,
    readonly routeStatus: 400 | 502,
  ) {
    super(message);
  }
}

export class InvalidFeishuCredentialsError extends FeishuApiError {
  constructor(message: string) {
    super(message, 400);
  }
}

function tokenIsFresh(expiresAt: Date | null): boolean {
  return (
    expiresAt !== null &&
    expiresAt.getTime() > nowDate().getTime() + TOKEN_REFRESH_WINDOW_MS
  );
}

async function readJson(response: Response): Promise<unknown> {
  const body = await response.json();
  if (!response.ok) {
    throw new FeishuApiError(
      `Feishu API returned HTTP ${response.status}`,
      response.status >= 500 ? 502 : 400,
    );
  }
  return body;
}

export async function fetchFeishuTenantAccessToken(args: {
  readonly appId: string;
  readonly appSecret: string;
  readonly signal: AbortSignal;
}): Promise<FeishuTenantAccessToken> {
  const response = await fetch(
    `${FEISHU_API_ORIGIN}/open-apis/auth/v3/tenant_access_token/internal`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        app_id: args.appId,
        app_secret: args.appSecret,
      }),
      signal: args.signal,
    },
  );
  const parsed = tenantAccessTokenResponseSchema.parse(
    await readJson(response),
  );
  if (parsed.code !== 0) {
    throw new InvalidFeishuCredentialsError(
      parsed.msg ?? "Feishu rejected the app credentials",
    );
  }
  if (!parsed.tenant_access_token || !parsed.expire) {
    throw new FeishuApiError(
      "Feishu tenant access token response is incomplete",
      502,
    );
  }
  return {
    token: parsed.tenant_access_token,
    expiresInSeconds: parsed.expire,
  };
}

export async function fetchFeishuBotInfo(args: {
  readonly tenantAccessToken: string;
  readonly signal: AbortSignal;
}): Promise<FeishuBotInfo> {
  const response = await fetch(`${FEISHU_API_ORIGIN}/open-apis/bot/v3/info`, {
    headers: {
      authorization: `Bearer ${args.tenantAccessToken}`,
      "content-type": "application/json; charset=utf-8",
    },
    signal: args.signal,
  });
  const parsed = feishuBotInfoResponseSchema.parse(await readJson(response));
  if (parsed.code !== 0) {
    throw new FeishuApiError(
      parsed.msg ?? "Feishu bot info request failed",
      400,
    );
  }
  const bot = parsed.bot ?? parsed.data?.bot;
  if (!bot?.open_id || !bot.app_name) {
    throw new FeishuApiError("Feishu bot info response is incomplete", 502);
  }
  return {
    openId: bot.open_id,
    name: bot.app_name,
    avatarUrl: bot.avatar_url ?? null,
  };
}

export async function exchangeFeishuOAuthCode(args: {
  readonly appId: string;
  readonly appSecret: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly signal: AbortSignal;
}): Promise<string> {
  const response = await fetch(
    `${FEISHU_API_ORIGIN}/open-apis/authen/v2/oauth/token`,
    {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: args.appId,
        client_secret: args.appSecret,
        code: args.code,
        redirect_uri: args.redirectUri,
      }),
      signal: args.signal,
    },
  );
  const parsed = feishuOAuthTokenResponseSchema.parse(await readJson(response));
  if (parsed.code !== 0) {
    throw new FeishuApiError(parsed.msg ?? "Feishu OAuth exchange failed", 400);
  }
  if (!parsed.access_token) {
    throw new FeishuApiError("Feishu OAuth token response is incomplete", 502);
  }
  return parsed.access_token;
}

export async function fetchFeishuUserInfo(args: {
  readonly userAccessToken: string;
  readonly signal: AbortSignal;
}): Promise<FeishuUserInfo> {
  const response = await fetch(
    `${FEISHU_API_ORIGIN}/open-apis/authen/v1/user_info`,
    {
      headers: {
        authorization: `Bearer ${args.userAccessToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      signal: args.signal,
    },
  );
  const parsed = feishuUserInfoResponseSchema.parse(await readJson(response));
  if (parsed.code !== 0) {
    throw new FeishuApiError(
      parsed.msg ?? "Feishu user info request failed",
      400,
    );
  }
  if (!parsed.data?.open_id) {
    throw new FeishuApiError("Feishu user info response is incomplete", 502);
  }
  return {
    name: parsed.data.name ?? null,
    openId: parsed.data.open_id,
    tenantKey: parsed.data.tenant_key ?? null,
  };
}

export async function getFeishuTenantAccessToken(args: {
  readonly db: Db;
  readonly installationId: string;
  readonly signal: AbortSignal;
}): Promise<string> {
  const [installation] = await args.db
    .select()
    .from(feishuOrgInstallations)
    .where(eq(feishuOrgInstallations.id, args.installationId))
    .limit(1);
  args.signal.throwIfAborted();
  if (!installation) {
    throw new Error("Feishu installation not found");
  }
  const context = { orgId: installation.orgId };
  if (
    installation.encryptedTenantAccessToken &&
    tokenIsFresh(installation.tenantAccessTokenExpiresAt)
  ) {
    return await decryptPersistentSecretValue(
      installation.encryptedTenantAccessToken,
      context,
    );
  }

  const appSecret = await decryptPersistentSecretValue(
    installation.encryptedAppSecret,
    context,
  );
  const token = await fetchFeishuTenantAccessToken({
    appId: installation.appId,
    appSecret,
    signal: args.signal,
  });
  const encryptedToken = await encryptPersistentSecretValue(
    token.token,
    context,
  );
  await args.db
    .update(feishuOrgInstallations)
    .set({
      encryptedTenantAccessToken: encryptedToken,
      tenantAccessTokenExpiresAt: new Date(
        nowDate().getTime() + token.expiresInSeconds * 1000,
      ),
      updatedAt: nowDate(),
    })
    .where(eq(feishuOrgInstallations.id, args.installationId));
  args.signal.throwIfAborted();
  return token.token;
}

function messagePayload(message: FeishuOutboundMessage): {
  readonly msg_type: FeishuOutboundMessage["msgType"];
  readonly content: string;
} {
  return {
    msg_type: message.msgType,
    content: JSON.stringify(message.content),
  };
}

function parseSentMessage(
  body: unknown,
  fallbackError: string,
): FeishuSentMessage {
  const parsed = feishuMessageResponseSchema.parse(body);
  if (parsed.code !== 0) {
    throw new FeishuApiError(parsed.msg ?? fallbackError, 400);
  }
  if (!parsed.data?.message_id) {
    throw new FeishuApiError("Feishu message response is incomplete", 502);
  }
  return {
    messageId: parsed.data.message_id,
    chatId: parsed.data.chat_id ?? null,
  };
}

export async function sendFeishuMessage(args: {
  readonly db: Db;
  readonly installationId: string;
  readonly receiveIdType: "chat_id" | "open_id";
  readonly receiveId: string;
  readonly message: FeishuOutboundMessage;
  readonly idempotencyKey?: string;
  readonly signal: AbortSignal;
}): Promise<FeishuSentMessage> {
  const token = await getFeishuTenantAccessToken(args);
  const url = new URL(`${FEISHU_API_ORIGIN}/open-apis/im/v1/messages`);
  url.searchParams.set("receive_id_type", args.receiveIdType);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      receive_id: args.receiveId,
      ...messagePayload(args.message),
      ...(args.idempotencyKey ? { uuid: args.idempotencyKey } : {}),
    }),
    signal: args.signal,
  });
  return parseSentMessage(
    await readJson(response),
    "Feishu message send failed",
  );
}

export async function replyWithFeishuMessage(args: {
  readonly db: Db;
  readonly installationId: string;
  readonly messageId: string;
  readonly message: FeishuOutboundMessage;
  readonly replyInThread?: boolean;
  readonly signal: AbortSignal;
}): Promise<FeishuSentMessage> {
  const token = await getFeishuTenantAccessToken(args);
  const response = await fetch(
    `${FEISHU_API_ORIGIN}/open-apis/im/v1/messages/${encodeURIComponent(args.messageId)}/reply`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        ...messagePayload(args.message),
        ...(args.replyInThread ? { reply_in_thread: true } : {}),
      }),
      signal: args.signal,
    },
  );
  return parseSentMessage(
    await readJson(response),
    "Feishu message reply failed",
  );
}

export async function addFeishuMessageReaction(args: {
  readonly db: Db;
  readonly installationId: string;
  readonly messageId: string;
  readonly emojiType: string;
  readonly signal: AbortSignal;
}): Promise<string> {
  const token = await getFeishuTenantAccessToken(args);
  const response = await fetch(
    `${FEISHU_API_ORIGIN}/open-apis/im/v1/messages/${encodeURIComponent(args.messageId)}/reactions`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        reaction_type: { emoji_type: args.emojiType },
      }),
      signal: args.signal,
    },
  );
  const parsed = feishuReactionResponseSchema.parse(await readJson(response));
  if (parsed.code !== 0) {
    throw new FeishuApiError(
      parsed.msg ?? "Feishu message reaction failed",
      400,
    );
  }
  if (!parsed.data?.reaction_id) {
    throw new FeishuApiError(
      "Feishu message reaction response is incomplete",
      502,
    );
  }
  return parsed.data.reaction_id;
}

export async function removeFeishuMessageReaction(args: {
  readonly db: Db;
  readonly installationId: string;
  readonly messageId: string;
  readonly reactionId: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  const token = await getFeishuTenantAccessToken(args);
  const response = await fetch(
    `${FEISHU_API_ORIGIN}/open-apis/im/v1/messages/${encodeURIComponent(args.messageId)}/reactions/${encodeURIComponent(args.reactionId)}`,
    {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      signal: args.signal,
    },
  );
  const parsed = feishuResponseSchema.parse(await readJson(response));
  if (parsed.code !== 0) {
    throw new FeishuApiError(
      parsed.msg ?? "Feishu message reaction removal failed",
      400,
    );
  }
}

export async function listFeishuChatMessages(args: {
  readonly db: Db;
  readonly installationId: string;
  readonly chatId: string;
  readonly pageSize?: number;
  readonly signal: AbortSignal;
}): Promise<readonly FeishuHistoryMessage[]> {
  const token = await getFeishuTenantAccessToken(args);
  const url = new URL(`${FEISHU_API_ORIGIN}/open-apis/im/v1/messages`);
  url.searchParams.set("container_id_type", "chat");
  url.searchParams.set("container_id", args.chatId);
  url.searchParams.set("sort_type", "ByCreateTimeDesc");
  url.searchParams.set("page_size", String(args.pageSize ?? 50));
  url.searchParams.set("with_sender_name", "true");
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    signal: args.signal,
  });
  const parsed = feishuMessageHistoryResponseSchema.parse(
    await readJson(response),
  );
  if (parsed.code !== 0) {
    throw new FeishuApiError(
      parsed.msg ?? "Feishu message history request failed",
      400,
    );
  }
  return parsed.data?.items ?? [];
}
