import { createHmac, randomUUID } from "node:crypto";

import {
  integrationsTelegramBotListContract,
  integrationsTelegramMessageContract,
  integrationsTelegramUploadInitContract,
  integrationsGithubUploadCompleteContract,
  integrationsGithubUploadInitContract,
  integrationsPhoneDownloadFileContract,
  integrationsPhoneMessageContract,
  integrationsPhoneUploadCompleteContract,
  integrationsPhoneUploadInitContract,
  integrationsSlackMessageContract,
  integrationsSlackUploadCompleteContract,
  integrationsSlackUploadInitContract,
  integrationsTelegramUploadCompleteContract,
  type GithubUploadCompleteBody,
  type GithubUploadInitBody,
  type PhoneUploadCompleteBody,
  type PhoneUploadInitBody,
  type SendSlackMessageBody,
  type SendTelegramMessageBody,
  type SendPhoneMessageBody,
  type SlackUploadCompleteBody,
  type SlackUploadInitBody,
  type TelegramUploadInitBody,
  type TelegramUploadCompleteBody,
} from "@vm0/api-contracts/contracts/integrations";
import {
  integrationsGithubContract,
  type PatchGithubInstallationBody,
} from "@vm0/api-contracts/contracts/integrations-github";
import {
  githubOauthContract,
  type GithubAppSetupCallbackQuery,
  type GithubOauthConnectCallbackQuery,
  type GithubOauthConnectQuery,
  type GithubOauthInstallQuery,
} from "@vm0/api-contracts/contracts/github-oauth";
import { zeroIntegrationsAgentPhoneContract } from "@vm0/api-contracts/contracts/zero-integrations-agentphone";
import { zeroIntegrationsSlackContract } from "@vm0/api-contracts/contracts/zero-integrations-slack";
import { zeroIntegrationsTelegramContract } from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import {
  zeroSlackBrowserConnectContract,
  type ZeroSlackBrowserConnectQuery,
} from "@vm0/api-contracts/contracts/zero-slack-browser-connect";
import { zeroSlackChannelsContract } from "@vm0/api-contracts/contracts/zero-slack-channels";
import { zeroSlackConnectContract } from "@vm0/api-contracts/contracts/zero-slack-connect";
import { zeroSlackOauthContract } from "@vm0/api-contracts/contracts/zero-slack-oauth";

import { createApp } from "../../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../../lib/env";
import { now } from "../../../../lib/time";
import {
  accept,
  setupApp,
  type TestContext,
} from "../../../../__tests__/test-helpers";
import type { ApiTestUser, ApiTestUserOptions } from "./api-bdd";
import { createZeroRouteMocks } from "./zero-route-test";

interface AuthHeaders {
  readonly authorization?: string;
}

interface ClerkUserProfile {
  readonly id: string;
  readonly emailAddresses: readonly {
    readonly id: string;
    readonly emailAddress: string;
  }[];
  readonly primaryEmailAddressId: string;
  readonly firstName: string;
  readonly lastName: string;
}

interface IntegrationUserOptions extends ApiTestUserOptions {
  readonly email?: string;
}

interface TelegramAuthPayload {
  readonly id: number;
  readonly first_name?: string;
  readonly last_name?: string;
  readonly username?: string;
  readonly photo_url?: string;
  readonly auth_date: number;
  readonly hash: string;
}

interface TelegramConnectSignaturePayload {
  readonly telegramUserId: string;
  readonly telegramUsername?: string;
  readonly telegramDisplayName?: string;
  readonly timestamp: number;
  readonly signature: string;
}

interface TelegramLinkBody {
  readonly telegramBotId: string;
  readonly telegramAuth?: TelegramAuthPayload;
  readonly connectSignature?: TelegramConnectSignaturePayload;
}

interface TelegramRegisterBody {
  readonly botToken: string;
  readonly defaultAgentId?: string;
  readonly reinstallBotId?: string;
}

interface TelegramSetupStatusBody {
  readonly botToken: string;
  readonly origin?: string;
}

interface TelegramUpdateBody {
  readonly defaultAgentId?: string;
  readonly selectedAgentId?: string | null;
}

interface SlackConnectBody {
  readonly workspaceId: string;
  readonly slackUserId: string;
  readonly channelId?: string;
  readonly threadTs?: string;
}

const AGENTPHONE_API_BASE_URL = "https://api.agentphone.test";
const AGENTPHONE_AGENT_ID = "agt-bdd-agentphone";
const AGENTPHONE_PHONE_NUMBER = "+19039853128";
const SLACK_SIGNING_SECRET = "slack-bdd-signing-secret";

type SlackSignatureHeaders = Record<string, string>;
type SlackIngressPath =
  | "/api/zero/slack/commands"
  | "/api/zero/slack/events"
  | "/api/zero/slack/interactive";
type SlackIngressStatus = 200 | 400 | 401 | 503;
type SlackDownloadStatus = 200 | 400 | 401 | 404 | 413 | 502;
type AgentPhoneWebhookStatus = 200 | 400 | 401 | 404;
type TelegramWebhookStatus = 200 | 400 | 401 | 404;

interface SlackIngressResponse {
  readonly status: SlackIngressStatus;
  readonly body: unknown;
  readonly headers: Headers;
}

interface SlackDownloadResponse {
  readonly status: SlackDownloadStatus;
  readonly body: unknown;
  readonly headers: Headers;
}

interface AgentPhoneWebhookResponse {
  readonly status: AgentPhoneWebhookStatus;
  readonly body: unknown;
  readonly headers: Headers;
}

interface TelegramWebhookResponse {
  readonly status: TelegramWebhookStatus;
  readonly body: unknown;
  readonly headers: Headers;
}

function clerkUserProfile(actor: ApiTestUser): ClerkUserProfile {
  const emailId = `email_${actor.userId}`;
  return {
    id: actor.userId,
    emailAddresses: [{ id: emailId, emailAddress: actor.email }],
    primaryEmailAddressId: emailId,
    firstName: "BDD",
    lastName: "Integration",
  };
}

function createUser(options: IntegrationUserOptions = {}): ApiTestUser {
  const userId = options.userId ?? `user_${randomUUID()}`;
  const orgId =
    options.orgId === undefined ? `org_${randomUUID()}` : options.orgId;
  return {
    userId,
    orgId,
    orgRole:
      options.orgRole ?? (options.orgId === null ? undefined : "org:admin"),
    email: options.email ?? `${userId}@example.test`,
  };
}

function authHeaders(actor: ApiTestUser | null): AuthHeaders {
  return actor ? { authorization: "Bearer clerk-session" } : {};
}

function extraHeaders(headers: AuthHeaders): Record<string, string> {
  return headers.authorization ? { authorization: headers.authorization } : {};
}

function configureClerkDirectory(
  context: TestContext,
  actor: ApiTestUser | null,
): void {
  if (!actor) {
    context.mocks.clerk.users.getUserList.mockResolvedValue({ data: [] });
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [],
    });
    return;
  }

  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [clerkUserProfile(actor)],
  });
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: actor.orgId
      ? [
          {
            organization: { id: actor.orgId },
            role: actor.orgRole ?? "org:admin",
            createdAt: 1,
          },
        ]
      : [],
  });
}

function authenticate(
  context: TestContext,
  routeMocks: ReturnType<typeof createZeroRouteMocks>,
  actor: ApiTestUser | null,
): AuthHeaders {
  configureClerkDirectory(context, actor);

  if (!actor) {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    return {};
  }

  routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return authHeaders(actor);
}

async function parseRawResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return await response.json();
  }
  return await response.text();
}

async function requestRawSlackIngress(
  context: TestContext,
  path: SlackIngressPath,
  body: string,
  headers: SlackSignatureHeaders,
  contentType: string,
): Promise<SlackIngressResponse> {
  const response = await createApp({ signal: context.signal }).request(path, {
    method: "POST",
    headers: {
      "content-type": contentType,
      ...headers,
    },
    body,
  });
  const result = {
    body: await parseRawResponseBody(response),
    headers: response.headers,
  };

  switch (response.status) {
    case 200: {
      return { status: 200, ...result };
    }
    case 400: {
      return { status: 400, ...result };
    }
    case 401: {
      return { status: 401, ...result };
    }
    case 503: {
      return { status: 503, ...result };
    }
    default: {
      throw new Error(`Unexpected Slack ingress status ${response.status}`);
    }
  }
}

async function requestRawAgentPhoneWebhook(
  context: TestContext,
  body: string,
  headers: {
    readonly "x-webhook-signature"?: string;
    readonly "x-webhook-timestamp"?: string;
    readonly "x-webhook-event"?: string;
    readonly "x-webhook-id"?: string;
  },
): Promise<AgentPhoneWebhookResponse> {
  const response = await createApp({ signal: context.signal }).request(
    "/api/agentphone/webhook",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body,
    },
  );
  const result = {
    body: await parseRawResponseBody(response),
    headers: response.headers,
  };

  switch (response.status) {
    case 200: {
      return { status: 200, ...result };
    }
    case 400: {
      return { status: 400, ...result };
    }
    case 401: {
      return { status: 401, ...result };
    }
    case 404: {
      return { status: 404, ...result };
    }
    default: {
      throw new Error(
        `Unexpected AgentPhone webhook status ${response.status}`,
      );
    }
  }
}

async function requestRawTelegramWebhook(
  context: TestContext,
  telegramBotId: string,
  body: string,
  headers: { readonly "x-telegram-bot-api-secret-token"?: string },
): Promise<TelegramWebhookResponse> {
  const response = await createApp({ signal: context.signal }).request(
    `/api/telegram/webhook/${telegramBotId}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body,
    },
  );
  const result = {
    body: await parseRawResponseBody(response),
    headers: response.headers,
  };

  switch (response.status) {
    case 200: {
      return { status: 200, ...result };
    }
    case 400: {
      return { status: 400, ...result };
    }
    case 401: {
      return { status: 401, ...result };
    }
    case 404: {
      return { status: 404, ...result };
    }
    default: {
      throw new Error(`Unexpected Telegram webhook status ${response.status}`);
    }
  }
}

async function requestRawSlackDownloadFile(
  context: TestContext,
  headers: AuthHeaders,
  fileId: string | undefined,
): Promise<SlackDownloadResponse> {
  const search = new URLSearchParams();
  if (fileId !== undefined) {
    search.set("file_id", fileId);
  }
  const query = search.toString();
  const response = await createApp({ signal: context.signal }).request(
    `/api/zero/integrations/slack/download-file${query ? `?${query}` : ""}`,
    {
      method: "GET",
      headers: extraHeaders(headers),
    },
  );
  const result = {
    body: await parseRawResponseBody(response),
    headers: response.headers,
  };

  switch (response.status) {
    case 200: {
      return { status: 200, ...result };
    }
    case 400: {
      return { status: 400, ...result };
    }
    case 401: {
      return { status: 401, ...result };
    }
    case 404: {
      return { status: 404, ...result };
    }
    case 413: {
      return { status: 413, ...result };
    }
    case 502: {
      return { status: 502, ...result };
    }
    default: {
      throw new Error(
        `Unexpected Slack download-file status ${response.status}`,
      );
    }
  }
}

export function createBddIntegrationApi(context: TestContext) {
  const routeMocks = createZeroRouteMocks(context);

  return {
    user: createUser,

    configureAgentPhoneProvider(): void {
      mockOptionalEnv("AGENTPHONE_AGENT_ID", AGENTPHONE_AGENT_ID);
      mockOptionalEnv("AGENTPHONE_API_BASE_URL", AGENTPHONE_API_BASE_URL);
      mockOptionalEnv("AGENTPHONE_API_KEY", "agentphone-bdd-key");
      mockOptionalEnv("AGENTPHONE_PHONE_NUMBER", AGENTPHONE_PHONE_NUMBER);
    },

    clearAgentPhoneProvider(): void {
      mockOptionalEnv("AGENTPHONE_AGENT_ID", undefined);
      mockOptionalEnv("AGENTPHONE_API_BASE_URL", undefined);
      mockOptionalEnv("AGENTPHONE_API_KEY", undefined);
      mockOptionalEnv("AGENTPHONE_PHONE_NUMBER", undefined);
      mockOptionalEnv("AGENTPHONE_WEBHOOK_SECRET", undefined);
    },

    configureAgentPhoneWebhook(): void {
      mockOptionalEnv("AGENTPHONE_WEBHOOK_SECRET", "agentphone-bdd-secret");
      mockOptionalEnv("AGENTPHONE_PHONE_NUMBER", AGENTPHONE_PHONE_NUMBER);
    },

    configureGithubAppInstallProvider(): void {
      mockOptionalEnv("GITHUB_APP_SLUG", "bdd-github-app");
    },

    configureGithubAppCallbackProvider(): void {
      mockOptionalEnv("GITHUB_APP_ID", "12345");
      mockOptionalEnv("GITHUB_APP_PRIVATE_KEY", "bdd-private-key");
    },

    clearGithubAppProvider(): void {
      mockOptionalEnv("GITHUB_APP_SLUG", undefined);
      mockOptionalEnv("GITHUB_APP_ID", undefined);
      mockOptionalEnv("GITHUB_APP_PRIVATE_KEY", undefined);
      mockOptionalEnv("GITHUB_APP_CLIENT_ID", undefined);
      mockOptionalEnv("GITHUB_APP_CLIENT_SECRET", undefined);
      mockOptionalEnv("GH_OAUTH_CLIENT_ID", undefined);
      mockOptionalEnv("GH_OAUTH_CLIENT_SECRET", undefined);
    },

    async requestGithubOauthInstall(
      query: GithubOauthInstallQuery,
      statuses: readonly (307 | 503)[],
    ) {
      const client = setupApp({ context })(githubOauthContract);
      return await accept(client.install({ query }), statuses);
    },

    async requestGithubOauthConnect(
      actor: ApiTestUser | null,
      query: GithubOauthConnectQuery,
      statuses: readonly (307 | 401 | 503)[],
    ) {
      const client = setupApp({ context })(githubOauthContract);
      return await accept(
        client.connect({
          extraHeaders: extraHeaders(authenticate(context, routeMocks, actor)),
          query,
        }),
        statuses,
      );
    },

    async requestGithubOauthConnectCallback(
      query: GithubOauthConnectCallbackQuery,
      statuses: readonly 307[],
    ) {
      const client = setupApp({ context })(githubOauthContract);
      return await accept(client.connectCallback({ query }), statuses);
    },

    async requestGithubAppSetupCallback(
      query: GithubAppSetupCallbackQuery,
      statuses: readonly 307[],
    ) {
      const client = setupApp({ context })(githubOauthContract);
      return await accept(client.setupCallback({ query }), statuses);
    },

    async requestSlackDisconnect(
      actor: ApiTestUser | null,
      action: string | undefined,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({ context })(zeroIntegrationsSlackContract);
      return await accept(
        client.disconnect({
          headers: authenticate(context, routeMocks, actor),
          query: { action },
        }),
        statuses,
      );
    },

    async requestSlackIntegrationStatus(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401)[],
    ) {
      const client = setupApp({ context })(zeroIntegrationsSlackContract);
      return await accept(
        client.getStatus({
          headers: authenticate(context, routeMocks, actor),
        }),
        statuses,
      );
    },

    async requestListSlackChannels(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 404)[],
    ) {
      const client = setupApp({ context })(zeroSlackChannelsContract);
      return await accept(
        client.list({ headers: authenticate(context, routeMocks, actor) }),
        statuses,
      );
    },

    async requestSendSlackMessage(
      actor: ApiTestUser | null,
      body: SendSlackMessageBody,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({ context })(integrationsSlackMessageContract);
      return await accept(
        client.sendMessage({
          headers: authenticate(context, routeMocks, actor),
          body,
        }),
        statuses,
      );
    },

    async requestSlackUploadInit(
      actor: ApiTestUser | null,
      body: SlackUploadInitBody,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({ context })(integrationsSlackUploadInitContract);
      return await accept(
        client.init({
          headers: authenticate(context, routeMocks, actor),
          body,
        }),
        statuses,
      );
    },

    async requestSlackUploadComplete(
      actor: ApiTestUser | null,
      body: SlackUploadCompleteBody,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({ context })(
        integrationsSlackUploadCompleteContract,
      );
      return await accept(
        client.complete({
          headers: authenticate(context, routeMocks, actor),
          body,
        }),
        statuses,
      );
    },

    async requestSlackDownloadFile(
      actor: ApiTestUser | null,
      fileId: string | undefined,
      statuses: readonly SlackDownloadStatus[],
    ) {
      return await accept(
        requestRawSlackDownloadFile(
          context,
          authenticate(context, routeMocks, actor),
          fileId,
        ),
        statuses,
      );
    },

    async requestSlackConnectStatus(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401)[],
    ) {
      const client = setupApp({ context })(zeroSlackConnectContract);
      return await accept(
        client.getStatus({
          headers: authenticate(context, routeMocks, actor),
        }),
        statuses,
      );
    },

    async requestSlackConnect(
      actor: ApiTestUser | null,
      body: SlackConnectBody,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({ context })(zeroSlackConnectContract);
      return await accept(
        client.connect({
          headers: authenticate(context, routeMocks, actor),
          body,
        }),
        statuses,
      );
    },

    async requestSlackBrowserConnect(
      actor: ApiTestUser | null,
      query: ZeroSlackBrowserConnectQuery,
      statuses: readonly 307[],
    ) {
      const client = setupApp({ context })(zeroSlackBrowserConnectContract);
      return await accept(
        client.connect({
          extraHeaders: extraHeaders(authenticate(context, routeMocks, actor)),
          query,
        }),
        statuses,
      );
    },

    async requestSlackOauthInstall(
      query: {
        readonly orgId?: string;
        readonly vm0UserId?: string;
        readonly reinstall?: string;
        readonly prompt?: string;
      },
      statuses: readonly (307 | 503)[],
    ) {
      const client = setupApp({ context })(zeroSlackOauthContract);
      return await accept(client.install({ query }), statuses);
    },

    configureSlackOauthProvider(): void {
      mockEnv("SLACK_OAUTH_CLIENT_ID", "slack-bdd-client-id");
      mockOptionalEnv("SLACK_OAUTH_CLIENT_SECRET", "slack-bdd-client-secret");
    },

    configureSlackSigningSecret(): void {
      mockOptionalEnv("SLACK_SIGNING_SECRET", SLACK_SIGNING_SECRET);
    },

    signedSlackIngressHeaders(body: string): SlackSignatureHeaders {
      const timestamp = String(Math.floor(now() / 1000));
      return {
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": `v0=${createHmac("sha256", SLACK_SIGNING_SECRET)
          .update(`v0:${timestamp}:${body}`)
          .digest("hex")}`,
      };
    },

    async requestSlackEvent(
      body: string,
      headers: SlackSignatureHeaders,
      statuses: readonly (200 | 400 | 401 | 503)[],
    ) {
      return await accept(
        requestRawSlackIngress(
          context,
          "/api/zero/slack/events",
          body,
          headers,
          "application/json",
        ),
        statuses,
      );
    },

    async requestSlackCommand(
      body: string,
      headers: SlackSignatureHeaders,
      statuses: readonly (200 | 400 | 401 | 503)[],
    ) {
      return await accept(
        requestRawSlackIngress(
          context,
          "/api/zero/slack/commands",
          body,
          headers,
          "application/x-www-form-urlencoded",
        ),
        statuses,
      );
    },

    async requestSlackInteractive(
      body: string,
      headers: SlackSignatureHeaders,
      statuses: readonly (200 | 400 | 401 | 503)[],
    ) {
      return await accept(
        requestRawSlackIngress(
          context,
          "/api/zero/slack/interactive",
          body,
          headers,
          "application/x-www-form-urlencoded",
        ),
        statuses,
      );
    },

    async requestSlackOauthConnect(
      query: {
        readonly orgId?: string;
        readonly vm0UserId?: string;
        readonly prompt?: string;
      },
      statuses: readonly (307 | 400 | 404 | 503)[],
    ) {
      const client = setupApp({ context })(zeroSlackOauthContract);
      return await accept(client.connect({ query }), statuses);
    },

    async requestSlackOauthCallback(
      query: {
        readonly code?: string;
        readonly error?: string;
        readonly state?: string;
      },
      statuses: readonly (307 | 400 | 503)[],
    ) {
      const client = setupApp({ context })(zeroSlackOauthContract);
      return await accept(client.callback({ query }), statuses);
    },

    async requestReadTelegramBot(
      actor: ApiTestUser | null,
      botId: string,
      statuses: readonly (200 | 401 | 404)[],
    ) {
      const client = setupApp({ context })(zeroIntegrationsTelegramContract);
      return await accept(
        client.getBot({
          headers: authenticate(context, routeMocks, actor),
          params: { botId },
        }),
        statuses,
      );
    },

    async requestListTelegramIntegrations(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401)[],
    ) {
      const client = setupApp({ context })(zeroIntegrationsTelegramContract);
      return await accept(
        client.list({
          headers: authenticate(context, routeMocks, actor),
        }),
        statuses,
      );
    },

    async requestListTelegramBots(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 403)[],
    ) {
      const client = setupApp({ context })(integrationsTelegramBotListContract);
      return await accept(
        client.listBots({
          headers: authenticate(context, routeMocks, actor),
        }),
        statuses,
      );
    },

    async readTelegramLinkStatus(actor: ApiTestUser, botId: string) {
      const client = setupApp({ context })(zeroIntegrationsTelegramContract);
      const response = await accept(
        client.getLinkStatus({
          headers: authenticate(context, routeMocks, actor),
          query: { botId },
        }),
        [200],
      );
      return response.body;
    },

    async requestTelegramAuthCallback(statuses: readonly 200[]) {
      const client = setupApp({ context })(zeroIntegrationsTelegramContract);
      return await accept(client.authCallback(), statuses);
    },

    async requestTelegramAvatar(
      actor: ApiTestUser | null,
      botId: string,
      query: { readonly exp?: string; readonly sig?: string },
      statuses: readonly (200 | 401 | 404 | 413 | 502)[],
    ) {
      const client = setupApp({ context })(zeroIntegrationsTelegramContract);
      return await accept(
        client.avatar({
          headers: authenticate(context, routeMocks, actor),
          params: { botId },
          query,
        }),
        statuses,
      );
    },

    async requestLinkTelegram(
      actor: ApiTestUser | null,
      body: TelegramLinkBody,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 409)[],
    ) {
      const client = setupApp({ context })(zeroIntegrationsTelegramContract);
      return await accept(
        client.link({
          headers: authenticate(context, routeMocks, actor),
          body,
        }),
        statuses,
      );
    },

    async requestUnlinkTelegram(
      actor: ApiTestUser | null,
      botId: string | undefined,
      statuses: readonly (204 | 401 | 404)[],
    ) {
      const client = setupApp({ context })(zeroIntegrationsTelegramContract);
      return await accept(
        client.unlink({
          headers: authenticate(context, routeMocks, actor),
          query: { botId },
        }),
        statuses,
      );
    },

    async requestUpdateTelegramBot(
      actor: ApiTestUser | null,
      botId: string,
      body: TelegramUpdateBody,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({ context })(zeroIntegrationsTelegramContract);
      return await accept(
        client.updateBot({
          headers: authenticate(context, routeMocks, actor),
          params: { botId },
          body,
        }),
        statuses,
      );
    },

    async requestDisconnectTelegramBot(
      actor: ApiTestUser | null,
      botId: string,
      statuses: readonly (204 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({ context })(zeroIntegrationsTelegramContract);
      return await accept(
        client.disconnect({
          headers: authenticate(context, routeMocks, actor),
          params: { botId },
        }),
        statuses,
      );
    },

    async requestRegisterTelegramBot(
      actor: ApiTestUser | null,
      body: TelegramRegisterBody,
      statuses: readonly (
        | 200
        | 201
        | 400
        | 401
        | 403
        | 404
        | 409
        | 500
        | 502
      )[],
    ) {
      const client = setupApp({ context })(zeroIntegrationsTelegramContract);
      return await accept(
        client.register({
          headers: authenticate(context, routeMocks, actor),
          body,
        }),
        statuses,
      );
    },

    async requestTelegramSetupStatus(
      actor: ApiTestUser | null,
      body: TelegramSetupStatusBody,
      statuses: readonly (200 | 400 | 401 | 409)[],
    ) {
      const client = setupApp({ context })(zeroIntegrationsTelegramContract);
      return await accept(
        client.setupStatus({
          headers: authenticate(context, routeMocks, actor),
          body,
        }),
        statuses,
      );
    },

    async requestTelegramUploadInit(
      actor: ApiTestUser | null,
      body: TelegramUploadInitBody,
      statuses: readonly (200 | 400 | 401 | 403)[],
    ) {
      const client = setupApp({ context })(
        integrationsTelegramUploadInitContract,
      );
      return await accept(
        client.init({
          headers: authenticate(context, routeMocks, actor),
          body,
        }),
        statuses,
      );
    },

    async requestTelegramUploadComplete(
      actor: ApiTestUser | null,
      body: TelegramUploadCompleteBody,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 502)[],
    ) {
      const client = setupApp({ context })(
        integrationsTelegramUploadCompleteContract,
      );
      return await accept(
        client.complete({
          headers: authenticate(context, routeMocks, actor),
          body,
        }),
        statuses,
      );
    },

    async requestSendTelegramMessage(
      actor: ApiTestUser | null,
      body: SendTelegramMessageBody,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 502)[],
    ) {
      const client = setupApp({ context })(integrationsTelegramMessageContract);
      return await accept(
        client.sendMessage({
          headers: authenticate(context, routeMocks, actor),
          body,
        }),
        statuses,
      );
    },

    async readGithubInstallation(actor: ApiTestUser) {
      const client = setupApp({ context })(integrationsGithubContract);
      return await accept(
        client.getInstallation({
          headers: authenticate(context, routeMocks, actor),
        }),
        [200, 404],
      );
    },

    async requestUpdateGithubInstallation(
      actor: ApiTestUser | null,
      body: PatchGithubInstallationBody,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500)[],
    ) {
      const client = setupApp({ context })(integrationsGithubContract);
      return await accept(
        client.updateInstallation({
          headers: authenticate(context, routeMocks, actor),
          body,
        }),
        statuses,
      );
    },

    async requestGithubUploadInit(
      actor: ApiTestUser | null,
      body: GithubUploadInitBody,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500 | 502)[],
    ) {
      const client = setupApp({ context })(
        integrationsGithubUploadInitContract,
      );
      return await accept(
        client.init({
          headers: authenticate(context, routeMocks, actor),
          body,
        }),
        statuses,
      );
    },

    async requestGithubUploadComplete(
      actor: ApiTestUser | null,
      body: GithubUploadCompleteBody,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500 | 502)[],
    ) {
      const client = setupApp({ context })(
        integrationsGithubUploadCompleteContract,
      );
      return await accept(
        client.complete({
          headers: authenticate(context, routeMocks, actor),
          body,
        }),
        statuses,
      );
    },

    async getAgentPhoneLinkStatus(actor: ApiTestUser) {
      const client = setupApp({ context })(zeroIntegrationsAgentPhoneContract);
      const response = await accept(
        client.getLinkStatus({
          headers: authenticate(context, routeMocks, actor),
        }),
        [200],
      );
      return response.body;
    },

    async requestStartAgentPhoneLink(
      actor: ApiTestUser | null,
      body: { readonly phoneHandle: string },
      statuses: readonly (200 | 400 | 401 | 409 | 429 | 503)[],
    ) {
      const client = setupApp({ context })(zeroIntegrationsAgentPhoneContract);
      return await accept(
        client.startLink({
          headers: authenticate(context, routeMocks, actor),
          body,
        }),
        statuses,
      );
    },

    async requestUnlinkAgentPhone(
      actor: ApiTestUser | null,
      statuses: readonly (204 | 401 | 404)[],
    ) {
      const client = setupApp({ context })(zeroIntegrationsAgentPhoneContract);
      return await accept(
        client.unlink({
          headers: authenticate(context, routeMocks, actor),
        }),
        statuses,
      );
    },

    async requestConnectAgentPhone(
      actor: ApiTestUser | null,
      body: {
        readonly phoneHandle: string;
        readonly agentphoneAgentId: string;
        readonly timestamp: number;
        readonly signature: string;
        readonly channel?: string;
      },
      statuses: readonly (200 | 400 | 401 | 409)[],
    ) {
      const client = setupApp({ context })(zeroIntegrationsAgentPhoneContract);
      return await accept(
        client.connectAgentPhone({
          headers: authenticate(context, routeMocks, actor),
          body,
        }),
        statuses,
      );
    },

    async requestAgentPhoneWebhook(
      body: string,
      headers: {
        readonly "x-webhook-signature"?: string;
        readonly "x-webhook-timestamp"?: string;
        readonly "x-webhook-event"?: string;
        readonly "x-webhook-id"?: string;
      },
      statuses: readonly (200 | 400 | 401 | 404)[],
    ) {
      return await accept(
        requestRawAgentPhoneWebhook(context, body, headers),
        statuses,
      );
    },

    async requestTelegramWebhook(
      telegramBotId: string,
      body: string,
      headers: { readonly "x-telegram-bot-api-secret-token"?: string },
      statuses: readonly TelegramWebhookStatus[],
    ) {
      return await accept(
        requestRawTelegramWebhook(context, telegramBotId, body, headers),
        statuses,
      );
    },

    async requestPhoneUploadInit(
      actor: ApiTestUser | null,
      body: PhoneUploadInitBody,
      statuses: readonly (200 | 400 | 401 | 403)[],
    ) {
      const client = setupApp({ context })(integrationsPhoneUploadInitContract);
      return await accept(
        client.init({
          headers: authenticate(context, routeMocks, actor),
          body,
        }),
        statuses,
      );
    },

    async requestPhoneUploadComplete(
      actor: ApiTestUser | null,
      body: PhoneUploadCompleteBody,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 502)[],
    ) {
      const client = setupApp({ context })(
        integrationsPhoneUploadCompleteContract,
      );
      return await accept(
        client.complete({
          headers: authenticate(context, routeMocks, actor),
          body,
        }),
        statuses,
      );
    },

    async requestPhoneDownloadFile(
      actor: ApiTestUser | null,
      fileId: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 413 | 502)[],
    ) {
      const client = setupApp({ context })(
        integrationsPhoneDownloadFileContract,
      );
      return await accept(
        client.download({
          headers: authenticate(context, routeMocks, actor),
          query: { file_id: fileId },
        }),
        statuses,
      );
    },

    async requestSendPhoneMessage(
      actor: ApiTestUser | null,
      body: SendPhoneMessageBody,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 502)[],
    ) {
      const client = setupApp({ context })(integrationsPhoneMessageContract);
      return await accept(
        client.sendMessage({
          headers: authenticate(context, routeMocks, actor),
          body,
        }),
        statuses,
      );
    },
  };
}
