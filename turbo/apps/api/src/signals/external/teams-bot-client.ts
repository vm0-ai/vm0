import { z } from "zod";

import { env, optionalEnv } from "../../lib/env";
import { safeJsonParse, safeUrlParse, settle } from "../utils";

const BOT_FRAMEWORK_SCOPE = "https://api.botframework.com/.default";
const MICROSOFT_GRAPH_SCOPE = "https://graph.microsoft.com/.default";
const MICROSOFT_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

const teamsTokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    token_type: z.string().optional(),
    expires_in: z.union([z.number(), z.string()]).optional(),
  })
  .passthrough();

const teamsActivityResponseSchema = z
  .object({
    id: z.string().optional(),
  })
  .passthrough();

const teamsConversationResponseSchema = z
  .object({
    id: z.string().min(1),
  })
  .passthrough();

const teamsGraphIdentitySchema = z
  .object({
    id: z.string().nullable().optional(),
    displayName: z.string().nullable().optional(),
  })
  .passthrough();

const teamsGraphMessageSchema = z
  .object({
    id: z.string().optional(),
    createdDateTime: z.string().nullable().optional(),
    messageType: z.string().nullable().optional(),
    from: z
      .object({
        user: teamsGraphIdentitySchema.nullable().optional(),
        application: teamsGraphIdentitySchema.nullable().optional(),
        device: teamsGraphIdentitySchema.nullable().optional(),
      })
      .nullable()
      .optional(),
    body: z
      .object({
        content: z.string().nullable().optional(),
        contentType: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
  })
  .passthrough();

const teamsGraphMessagesResponseSchema = z
  .object({
    value: z.array(teamsGraphMessageSchema),
  })
  .passthrough();

type TeamsApiErrorResult = {
  readonly kind: "teams-error";
  readonly status: number;
  readonly error: string;
};

type SendTeamsActivityResult =
  | { readonly kind: "ok"; readonly activityId: string | undefined }
  | TeamsApiErrorResult;

type CreateTeamsConversationResult =
  | { readonly kind: "ok"; readonly conversationId: string }
  | TeamsApiErrorResult;

type FetchTeamsGraphMessageResult =
  | { readonly kind: "ok"; readonly message: TeamsGraphMessage }
  | TeamsApiErrorResult;

type FetchTeamsGraphMessagesResult =
  | { readonly kind: "ok"; readonly messages: readonly TeamsGraphMessage[] }
  | TeamsApiErrorResult;

export type TeamsGraphMessage = z.infer<typeof teamsGraphMessageSchema>;

interface TeamsBotCredentials {
  readonly appId: string;
  readonly appPassword: string;
}

interface TeamsAdaptiveCardTextBlock {
  readonly type: "TextBlock";
  readonly text: string;
  readonly wrap?: boolean;
}

interface TeamsAdaptiveCardOpenUrlAction {
  readonly type: "Action.OpenUrl";
  readonly title: string;
  readonly url: string;
}

export interface TeamsAdaptiveCard {
  readonly type: "AdaptiveCard";
  readonly version: "1.4";
  readonly body: readonly TeamsAdaptiveCardTextBlock[];
  readonly actions?: readonly TeamsAdaptiveCardOpenUrlAction[];
}

interface TeamsActivityAttachment {
  readonly contentType: "application/vnd.microsoft.card.adaptive";
  readonly content: TeamsAdaptiveCard;
}

interface TeamsActivityBody {
  readonly type: "message" | "typing";
  readonly text?: string;
  readonly textFormat?: "markdown";
  readonly summary?: string;
  readonly replyToId?: string;
  readonly attachments?: readonly TeamsActivityAttachment[];
  readonly channelData?: {
    readonly tenant?: { readonly id: string };
  };
}

interface TeamsConversationIdentity {
  readonly id: string;
  readonly name?: string;
}

interface TeamsCreateConversationBody {
  readonly bot: TeamsConversationIdentity;
  readonly members: readonly TeamsConversationIdentity[];
  readonly isGroup: false;
  readonly channelData: {
    readonly tenant: { readonly id: string };
  };
}

function teamsBotCredentials(): TeamsBotCredentials | undefined {
  const appId = env("MICROSOFT_TEAMS_BOT_APP_ID");
  const appPassword = env("MICROSOFT_TEAMS_BOT_APP_PASSWORD");
  if (!appId || !appPassword) {
    return undefined;
  }
  return { appId, appPassword };
}

function tenantTokenUrl(tenantId: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(
    tenantId,
  )}/oauth2/v2.0/token`;
}

function botTokenUrl(tenantId: string): string {
  return (
    optionalEnv("MICROSOFT_TEAMS_BOT_TOKEN_URL") ?? tenantTokenUrl(tenantId)
  );
}

function graphTokenUrl(tenantId: string): string {
  return tenantTokenUrl(tenantId);
}

function networkErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Network request failed";
}

function teamsApiError(status: number, error: string): TeamsApiErrorResult {
  return { kind: "teams-error", status, error };
}

async function fetchClientCredentialsAccessToken(args: {
  readonly tokenUrl: string;
  readonly scope: string;
  readonly signal: AbortSignal;
}): Promise<
  { readonly kind: "ok"; readonly accessToken: string } | TeamsApiErrorResult
> {
  const credentials = teamsBotCredentials();
  if (!credentials) {
    return teamsApiError(
      502,
      "Microsoft Teams bot credentials are not configured",
    );
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: credentials.appId,
    client_secret: credentials.appPassword,
    scope: args.scope,
  });

  const responseResult = await settle(
    fetch(args.tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      signal: args.signal,
    }),
    args.signal,
  );
  if (!responseResult.ok) {
    return teamsApiError(502, networkErrorMessage(responseResult.error));
  }

  const response = responseResult.value;
  if (!response.ok) {
    const text = await response.text();
    args.signal.throwIfAborted();
    return teamsApiError(
      502,
      text || `OAuth token request failed with HTTP ${response.status}`,
    );
  }

  const parsed = teamsTokenResponseSchema.safeParse(
    safeJsonParse(await response.text()),
  );
  args.signal.throwIfAborted();
  if (!parsed.success) {
    return teamsApiError(502, "Invalid OAuth token response");
  }

  return { kind: "ok", accessToken: parsed.data.access_token };
}

function fetchTeamsBotAccessToken(args: {
  readonly tenantId: string;
  readonly signal: AbortSignal;
}): Promise<
  { readonly kind: "ok"; readonly accessToken: string } | TeamsApiErrorResult
> {
  return fetchClientCredentialsAccessToken({
    tokenUrl: botTokenUrl(args.tenantId),
    scope: BOT_FRAMEWORK_SCOPE,
    signal: args.signal,
  });
}

function fetchTeamsGraphAccessToken(args: {
  readonly tenantId: string;
  readonly signal: AbortSignal;
}): Promise<
  { readonly kind: "ok"; readonly accessToken: string } | TeamsApiErrorResult
> {
  return fetchClientCredentialsAccessToken({
    tokenUrl: graphTokenUrl(args.tenantId),
    scope: MICROSOFT_GRAPH_SCOPE,
    signal: args.signal,
  });
}

function teamsConversationActivityUrl(args: {
  readonly serviceUrl: string;
  readonly conversationId: string;
  readonly activityId: string | undefined;
}): string | undefined {
  const parsed = safeUrlParse(args.serviceUrl);
  if (
    !parsed ||
    (parsed.protocol !== "https:" && parsed.protocol !== "http:")
  ) {
    return undefined;
  }

  const serviceUrl = parsed.href.replace(/\/+$/u, "");
  const conversationId = encodeURIComponent(args.conversationId);
  const base = `${serviceUrl}/v3/conversations/${conversationId}/activities`;
  return args.activityId
    ? `${base}/${encodeURIComponent(args.activityId)}`
    : base;
}

function teamsConversationsUrl(serviceUrl: string): string | undefined {
  const parsed = safeUrlParse(serviceUrl);
  if (
    !parsed ||
    (parsed.protocol !== "https:" && parsed.protocol !== "http:")
  ) {
    return undefined;
  }

  return `${parsed.href.replace(/\/+$/u, "")}/v3/conversations`;
}

function teamsGraphChannelMessageUrl(args: {
  readonly teamId: string;
  readonly channelId: string;
  readonly messageId?: string;
  readonly replies?: boolean;
  readonly limit?: number;
}): string {
  const base = `${MICROSOFT_GRAPH_BASE_URL}/teams/${encodeURIComponent(
    args.teamId,
  )}/channels/${encodeURIComponent(args.channelId)}/messages`;
  const path = args.messageId
    ? `${base}/${encodeURIComponent(args.messageId)}${
        args.replies ? "/replies" : ""
      }`
    : base;
  const url = new URL(path);
  if (args.limit) {
    url.searchParams.set("$top", String(args.limit));
  }
  return url.toString();
}

async function fetchTeamsGraphJson<T>(args: {
  readonly tenantId: string;
  readonly url: string;
  readonly schema: z.ZodType<T>;
  readonly signal: AbortSignal;
}): Promise<{ readonly kind: "ok"; readonly data: T } | TeamsApiErrorResult> {
  const accessToken = await fetchTeamsGraphAccessToken({
    tenantId: args.tenantId,
    signal: args.signal,
  });
  if (accessToken.kind === "teams-error") {
    return accessToken;
  }

  const responseResult = await settle(
    fetch(args.url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken.accessToken}`,
      },
      signal: args.signal,
    }),
    args.signal,
  );
  if (!responseResult.ok) {
    return teamsApiError(502, networkErrorMessage(responseResult.error));
  }

  const response = responseResult.value;
  const responseText = await response.text();
  args.signal.throwIfAborted();
  if (!response.ok) {
    return teamsApiError(
      response.status,
      responseText || `Microsoft Graph API returned HTTP ${response.status}`,
    );
  }

  const parsed = args.schema.safeParse(safeJsonParse(responseText));
  if (!parsed.success) {
    return teamsApiError(502, "Invalid Microsoft Graph response");
  }
  return { kind: "ok", data: parsed.data };
}

async function postTeamsActivity(args: {
  readonly serviceUrl: string;
  readonly conversationId: string;
  readonly activityId?: string;
  readonly tenantId: string;
  readonly activity: TeamsActivityBody;
  readonly signal: AbortSignal;
}): Promise<SendTeamsActivityResult> {
  const accessToken = await fetchTeamsBotAccessToken({
    tenantId: args.tenantId,
    signal: args.signal,
  });
  if (accessToken.kind === "teams-error") {
    return accessToken;
  }

  const url = teamsConversationActivityUrl({
    serviceUrl: args.serviceUrl,
    conversationId: args.conversationId,
    activityId: args.activityId,
  });
  if (!url) {
    return teamsApiError(400, "Invalid Microsoft Teams serviceUrl");
  }

  const responseResult = await settle(
    fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(args.activity),
      signal: args.signal,
    }),
    args.signal,
  );
  if (!responseResult.ok) {
    return teamsApiError(502, networkErrorMessage(responseResult.error));
  }

  const response = responseResult.value;
  const responseText = await response.text();
  args.signal.throwIfAborted();
  if (!response.ok) {
    return teamsApiError(
      response.status,
      responseText || `Microsoft Teams API returned HTTP ${response.status}`,
    );
  }

  if (!responseText) {
    return { kind: "ok", activityId: undefined };
  }

  const parsed = teamsActivityResponseSchema.safeParse(
    safeJsonParse(responseText),
  );
  return {
    kind: "ok",
    activityId: parsed.success ? parsed.data.id : undefined,
  };
}

export async function createTeamsPersonalConversation(args: {
  readonly serviceUrl: string;
  readonly tenantId: string;
  readonly botId: string;
  readonly botName?: string | null;
  readonly teamsUserId: string;
  readonly teamsUserDisplayName?: string | null;
  readonly signal: AbortSignal;
}): Promise<CreateTeamsConversationResult> {
  const accessToken = await fetchTeamsBotAccessToken({
    tenantId: args.tenantId,
    signal: args.signal,
  });
  if (accessToken.kind === "teams-error") {
    return accessToken;
  }

  const url = teamsConversationsUrl(args.serviceUrl);
  if (!url) {
    return teamsApiError(400, "Invalid Microsoft Teams serviceUrl");
  }

  const body: TeamsCreateConversationBody = {
    bot: {
      id: args.botId,
      ...(args.botName ? { name: args.botName } : {}),
    },
    members: [
      {
        id: args.teamsUserId,
        ...(args.teamsUserDisplayName
          ? { name: args.teamsUserDisplayName }
          : {}),
      },
    ],
    isGroup: false,
    channelData: {
      tenant: { id: args.tenantId },
    },
  };

  const responseResult = await settle(
    fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: args.signal,
    }),
    args.signal,
  );
  if (!responseResult.ok) {
    return teamsApiError(502, networkErrorMessage(responseResult.error));
  }

  const response = responseResult.value;
  const responseText = await response.text();
  args.signal.throwIfAborted();
  if (!response.ok) {
    return teamsApiError(
      response.status,
      responseText || `Microsoft Teams API returned HTTP ${response.status}`,
    );
  }

  const parsed = teamsConversationResponseSchema.safeParse(
    safeJsonParse(responseText),
  );
  if (!parsed.success) {
    return teamsApiError(502, "Invalid Microsoft Teams conversation response");
  }

  return { kind: "ok", conversationId: parsed.data.id };
}

export function sendTeamsMessageReply(args: {
  readonly serviceUrl: string;
  readonly conversationId: string;
  readonly activityId?: string;
  readonly tenantId: string;
  readonly text: string;
  readonly card?: TeamsAdaptiveCard;
  readonly signal: AbortSignal;
}): Promise<SendTeamsActivityResult> {
  return postTeamsActivity({
    serviceUrl: args.serviceUrl,
    conversationId: args.conversationId,
    activityId: args.activityId,
    tenantId: args.tenantId,
    signal: args.signal,
    activity: {
      type: "message",
      ...(args.card
        ? { summary: args.text }
        : { text: args.text, textFormat: "markdown" }),
      replyToId: args.activityId,
      ...(args.card
        ? {
            attachments: [
              {
                contentType: "application/vnd.microsoft.card.adaptive",
                content: args.card,
              },
            ],
          }
        : {}),
      channelData: {
        tenant: { id: args.tenantId },
      },
    },
  });
}

export function sendTeamsTypingActivity(args: {
  readonly serviceUrl: string;
  readonly conversationId: string;
  readonly tenantId: string;
  readonly signal: AbortSignal;
}): Promise<SendTeamsActivityResult> {
  return postTeamsActivity({
    serviceUrl: args.serviceUrl,
    conversationId: args.conversationId,
    tenantId: args.tenantId,
    signal: args.signal,
    activity: {
      type: "typing",
      channelData: {
        tenant: { id: args.tenantId },
      },
    },
  });
}

export async function fetchTeamsChannelMessages(args: {
  readonly tenantId: string;
  readonly teamId: string;
  readonly channelId: string;
  readonly limit: number;
  readonly signal: AbortSignal;
}): Promise<FetchTeamsGraphMessagesResult> {
  const result = await fetchTeamsGraphJson({
    tenantId: args.tenantId,
    url: teamsGraphChannelMessageUrl({
      teamId: args.teamId,
      channelId: args.channelId,
      limit: args.limit,
    }),
    schema: teamsGraphMessagesResponseSchema,
    signal: args.signal,
  });
  if (result.kind === "teams-error") {
    return result;
  }
  return { kind: "ok", messages: result.data.value };
}

export async function fetchTeamsChannelMessage(args: {
  readonly tenantId: string;
  readonly teamId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly signal: AbortSignal;
}): Promise<FetchTeamsGraphMessageResult> {
  const result = await fetchTeamsGraphJson({
    tenantId: args.tenantId,
    url: teamsGraphChannelMessageUrl({
      teamId: args.teamId,
      channelId: args.channelId,
      messageId: args.messageId,
    }),
    schema: teamsGraphMessageSchema,
    signal: args.signal,
  });
  if (result.kind === "teams-error") {
    return result;
  }
  return { kind: "ok", message: result.data };
}

export async function fetchTeamsChannelMessageReplies(args: {
  readonly tenantId: string;
  readonly teamId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly limit: number;
  readonly signal: AbortSignal;
}): Promise<FetchTeamsGraphMessagesResult> {
  const result = await fetchTeamsGraphJson({
    tenantId: args.tenantId,
    url: teamsGraphChannelMessageUrl({
      teamId: args.teamId,
      channelId: args.channelId,
      messageId: args.messageId,
      replies: true,
      limit: args.limit,
    }),
    schema: teamsGraphMessagesResponseSchema,
    signal: args.signal,
  });
  if (result.kind === "teams-error") {
    return result;
  }
  return { kind: "ok", messages: result.data.value };
}
