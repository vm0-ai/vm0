import { z } from "zod";

import { env, optionalEnv } from "../../lib/env";
import { safeJsonParse, safeUrlParse, settle } from "../utils";

const BOT_FRAMEWORK_TOKEN_URL =
  "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token";
const BOT_FRAMEWORK_SCOPE = "https://api.botframework.com/.default";

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

type SendTeamsActivityResult =
  | { readonly kind: "ok"; readonly activityId: string | undefined }
  | {
      readonly kind: "teams-error";
      readonly status: number;
      readonly error: string;
    };

interface TeamsBotCredentials {
  readonly appId: string;
  readonly appPassword: string;
}

interface TeamsActivityBody {
  readonly type: "message" | "typing";
  readonly text?: string;
  readonly textFormat?: "markdown";
  readonly replyToId?: string;
  readonly channelData?: {
    readonly tenant?: { readonly id: string };
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

function tokenUrl(): string {
  return (
    optionalEnv("MICROSOFT_TEAMS_BOT_TOKEN_URL") ?? BOT_FRAMEWORK_TOKEN_URL
  );
}

function networkErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Network request failed";
}

function teamsApiError(
  status: number,
  error: string,
): Extract<SendTeamsActivityResult, { readonly kind: "teams-error" }> {
  return { kind: "teams-error", status, error };
}

async function fetchTeamsBotAccessToken(
  signal: AbortSignal,
): Promise<
  | { readonly kind: "ok"; readonly accessToken: string }
  | Extract<SendTeamsActivityResult, { readonly kind: "teams-error" }>
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
    scope: BOT_FRAMEWORK_SCOPE,
  });

  const responseResult = await settle(
    fetch(tokenUrl(), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      signal,
    }),
    signal,
  );
  if (!responseResult.ok) {
    return teamsApiError(502, networkErrorMessage(responseResult.error));
  }

  const response = responseResult.value;
  if (!response.ok) {
    const text = await response.text();
    signal.throwIfAborted();
    return teamsApiError(
      502,
      text || `Bot Framework token request failed with HTTP ${response.status}`,
    );
  }

  const parsed = teamsTokenResponseSchema.safeParse(
    safeJsonParse(await response.text()),
  );
  signal.throwIfAborted();
  if (!parsed.success) {
    return teamsApiError(502, "Invalid Bot Framework token response");
  }

  return { kind: "ok", accessToken: parsed.data.access_token };
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

async function postTeamsActivity(args: {
  readonly serviceUrl: string;
  readonly conversationId: string;
  readonly activityId?: string;
  readonly activity: TeamsActivityBody;
  readonly signal: AbortSignal;
}): Promise<SendTeamsActivityResult> {
  const accessToken = await fetchTeamsBotAccessToken(args.signal);
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

export function sendTeamsMessageReply(args: {
  readonly serviceUrl: string;
  readonly conversationId: string;
  readonly activityId?: string;
  readonly tenantId: string;
  readonly text: string;
  readonly signal: AbortSignal;
}): Promise<SendTeamsActivityResult> {
  return postTeamsActivity({
    serviceUrl: args.serviceUrl,
    conversationId: args.conversationId,
    activityId: args.activityId,
    signal: args.signal,
    activity: {
      type: "message",
      text: args.text,
      textFormat: "markdown",
      replyToId: args.activityId,
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
    signal: args.signal,
    activity: {
      type: "typing",
      channelData: {
        tenant: { id: args.tenantId },
      },
    },
  });
}
