import {
  createCipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { Buffer } from "node:buffer";

import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import {
  chatThreadEventsContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  zeroCustomConnectorOAuth2Contract,
  zeroCustomConnectorSecretContract,
  zeroCustomConnectorsContract,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { zeroFeishuConnectContract } from "@vm0/api-contracts/contracts/zero-feishu-connect";
import { zeroFeishuOauthContract } from "@vm0/api-contracts/contracts/zero-feishu-oauth";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { getCustomConnectorSkillStorageName } from "@vm0/core/storage-names";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createAppWithRoutes } from "../../../app-factory-core";
import { env, mockEnv, mockOptionalEnv } from "../../../lib/env";
import { extractFileFromTarGz } from "../../../lib/tar";
import { server } from "../../../mocks/server";
import {
  decryptChatEventInputParamsFixture,
  findPendingChatEventInputParamsByPromptFixture,
  readChatEventContextFixture,
  readChatEventInputParamsFixture,
  useLegacyFeishuTenantKeyFixture,
} from "../../../test-fixtures/chat-events";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { now } from "../../external/time";
import { createDeferredPromise } from "../../utils";
import { zeroFeishuBrowserConnectRoutes } from "../zero-feishu-browser-connect";
import { zeroFeishuEventsRoutes } from "../zero-feishu-events";
import { zeroFeishuOauthRoutes } from "../zero-feishu-oauth";
import { zeroIntegrationsFeishuFileRoutes } from "../zero-integrations-feishu-files";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import {
  createRunsApi,
  expectCanonicalStorageManifest,
} from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const authOrgApi = createAuthOrgAgentsBddApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const runsApi = createRunsApi(context);
const webhooksApi = createWebhookCallbackApi(context);
const APP_ORIGIN = "https://app.vm0.test";
const ENCRYPT_KEY = "feishu-test-encrypt-key";
const VERIFICATION_TOKEN = "feishu-test-verification-token";
const APP_SECRET = "feishu-test-secret";
const TENANT_KEY = "tenant_feishu_integration_test";
const BOT_OPEN_ID = "ou_feishu_bot";
const EXPECTED_FEISHU_OAUTH_SCOPES = [
  "offline_access",
  "contact:contact.base:readonly",
  "contact:user.base:readonly",
  "contact:user.id:readonly",
  "contact:user:search",
  "im:chat",
  "im:chat:create_by_user",
  "im:chat.members:read",
  "im:chat.members:write_only",
  "im:message",
  "im:message.p2p_msg:get_as_user",
  "im:message.group_msg:get_as_user",
  "im:message.send_as_user",
  "im:message.reactions:read",
  "im:message.reactions:write_only",
  "im:resource",
  "drive:drive",
  "drive:file",
  "drive:export:readonly",
  "docx:document",
  "docx:document.block:convert",
  "docs:document:import",
  "docs:document.media:upload",
  "docs:document.media:download",
  "docs:document.comment:create",
  "docs:document.comment:read",
  "docs:document.comment:write_only",
  "sheets:spreadsheet",
  "bitable:app",
  "wiki:wiki",
  "search:docs:read",
  "slides:presentation:read",
  "slides:presentation:write_only",
  "board:whiteboard:node:read",
  "board:whiteboard:node:create",
  "calendar:calendar",
  "task:task:write",
  "task:tasklist:write",
] as const;

interface CapturedFeishuMessage {
  readonly kind: "reply" | "send";
  readonly target: string;
  readonly msgType: "interactive" | "text";
  readonly content: Readonly<Record<string, unknown>>;
  readonly replyInThread: boolean;
}

interface FeishuMessageRequestBody {
  readonly receive_id?: string;
  readonly msg_type: "interactive" | "text";
  readonly content: string;
  readonly reply_in_thread?: boolean;
}

interface FeishuRunFixture {
  readonly actor: ApiTestUser;
  readonly runnerGroup: string;
  readonly appId: string;
  readonly callbackUrl: string;
  readonly installationId: string;
  readonly defaultAgentId: string;
  readonly alternateAgentId: string;
}

function messageContent(message: CapturedFeishuMessage): string {
  return JSON.stringify(message.content);
}

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}

function feishuConnectBody(connectUrl: string) {
  const url = new URL(connectUrl);
  return {
    installationId: requireValue(
      url.searchParams.get("installationId"),
      "Expected installationId in Feishu connect URL",
    ),
    openId: requireValue(
      url.searchParams.get("openId"),
      "Expected openId in Feishu connect URL",
    ),
    chatId: requireValue(
      url.searchParams.get("chatId"),
      "Expected chatId in Feishu connect URL",
    ),
    ts: Number(
      requireValue(
        url.searchParams.get("ts"),
        "Expected timestamp in Feishu connect URL",
      ),
    ),
    sig: requireValue(
      url.searchParams.get("sig"),
      "Expected signature in Feishu connect URL",
    ),
  };
}

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof command.input === "object" &&
    command.input !== null
  ) {
    return command.input as Record<string, unknown>;
  }
  return {};
}

function uploadedSkillMarkdown(): string {
  for (const [command] of context.mocks.s3.send.mock.calls) {
    const input = commandInput(command);
    if (
      !String(input.Key).endsWith("/archive.tar.gz") ||
      !Buffer.isBuffer(input.Body)
    ) {
      continue;
    }
    const skillMarkdown = extractFileFromTarGz(input.Body, "SKILL.md");
    if (skillMarkdown !== null) {
      return skillMarkdown;
    }
  }
  throw new Error("Expected an uploaded SKILL.md");
}

function legacyFeishuAppOAuthState(args: {
  readonly installationId: string;
  readonly orgId: string;
  readonly userId: string;
}): string {
  const encodedPayload = Buffer.from(
    JSON.stringify({
      ...args,
      callbackTarget: "app",
      timestamp: Math.floor(now() / 1000),
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(encodedPayload)
    .digest("base64url");
  return `${encodedPayload}.${signature}`;
}

function encryptPayload(payload: unknown): string {
  const key = createHash("sha256").update(ENCRYPT_KEY).digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return JSON.stringify({
    encrypt: Buffer.concat([iv, encrypted]).toString("base64"),
  });
}

function signedHeaders(body: string, timestamp: number): HeadersInit {
  const nonce = randomUUID();
  const signature = createHash("sha256")
    .update(`${String(timestamp)}${nonce}${ENCRYPT_KEY}${body}`)
    .digest("hex");
  return {
    "content-type": "application/json",
    "x-lark-request-timestamp": String(timestamp),
    "x-lark-request-nonce": nonce,
    "x-lark-signature": signature,
  };
}

async function postEvent(
  callbackUrl: string,
  payload: unknown,
  options: {
    readonly encrypted?: boolean;
    readonly signed?: boolean;
    readonly validSignature?: boolean;
    readonly timestamp?: number;
  } = {},
): Promise<Response> {
  const body = options.encrypted
    ? encryptPayload(payload)
    : JSON.stringify(payload);
  const headers = new Headers(
    options.signed === false
      ? { "content-type": "application/json" }
      : signedHeaders(body, options.timestamp ?? Math.floor(now() / 1000)),
  );
  if (options.validSignature === false) {
    headers.set("x-lark-signature", "invalid");
  }
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: zeroFeishuEventsRoutes,
  });
  return await app.request(callbackUrl, {
    method: "POST",
    headers,
    body,
  });
}

function v2Event(appId: string, eventType: string, event: unknown): unknown {
  return {
    schema: "2.0",
    header: {
      event_id: randomUUID(),
      event_type: eventType,
      tenant_key: TENANT_KEY,
      app_id: appId,
      token: VERIFICATION_TOKEN,
    },
    event,
  };
}

function directMessage(
  appId: string,
  text: string,
  openId = "ou_feishu_user",
  options: {
    readonly chatId?: string;
    readonly messageId?: string;
    readonly rootId?: string;
    readonly threadId?: string;
  } = {},
): unknown {
  return v2Event(appId, "im.message.receive_v1", {
    sender: {
      sender_id: { open_id: openId },
      sender_type: "user",
    },
    message: {
      message_id: options.messageId ?? `om_${randomUUID()}`,
      root_id: options.rootId,
      thread_id: options.threadId,
      chat_id: options.chatId ?? "oc_feishu_dm",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text }),
    },
  });
}

function directFileMessage(
  appId: string,
  options: {
    readonly messageId: string;
    readonly fileKey: string;
    readonly filename: string;
  },
): unknown {
  return v2Event(appId, "im.message.receive_v1", {
    sender: {
      sender_id: { open_id: "ou_feishu_user" },
      sender_type: "user",
    },
    message: {
      message_id: options.messageId,
      chat_id: "oc_feishu_dm",
      chat_type: "p2p",
      message_type: "file",
      content: JSON.stringify({
        file_key: options.fileKey,
        file_name: options.filename,
      }),
    },
  });
}

function groupMessage(
  appId: string,
  text: string,
  options: {
    readonly mentionBot?: boolean;
    readonly mentionOpenId?: string;
    readonly messageId?: string;
    readonly rootId?: string;
    readonly senderType?: string;
    readonly threadId?: string;
    readonly openId?: string;
  } = {},
): unknown {
  const mentionKey = "@_user_1";
  const mentionBot = options.mentionBot ?? true;
  return v2Event(appId, "im.message.receive_v1", {
    sender: {
      sender_id: { open_id: options.openId ?? "ou_feishu_user" },
      sender_type: options.senderType ?? "user",
    },
    message: {
      message_id: options.messageId ?? `om_${randomUUID()}`,
      chat_id: "oc_feishu_group",
      chat_type: "group",
      root_id: options.rootId,
      thread_id: options.threadId,
      message_type: "text",
      content: JSON.stringify({
        text: mentionBot ? `${mentionKey} ${text}` : text,
      }),
      mentions: mentionBot
        ? [
            {
              key: mentionKey,
              id: { open_id: options.mentionOpenId ?? BOT_OPEN_ID },
              name: "Zero",
            },
          ]
        : [],
    },
  });
}

async function enableFeishuIntegration(
  actor: {
    readonly userId: string;
    readonly orgId: string | null;
  },
  extraSwitches: Readonly<Record<string, boolean>> = {},
): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Feishu integration tests require an organization");
  }
  await updateFeatureSwitchesForUser(
    context,
    { userId: actor.userId, orgId: actor.orgId },
    {
      [FeatureSwitchKey.FeishuIntegration]: true,
      ...extraSwitches,
    },
  );
}

describe("Feishu integration", () => {
  let oauthUserOpenId: string;
  let outboundMessages: CapturedFeishuMessage[];
  let addedReactions: string[];
  let removedReactions: string[];
  let historyMessages: readonly Readonly<Record<string, unknown>>[];
  let failedSendTargets: string[];
  let oauthTokenExpiresInSeconds: number;
  let oauthTokenGrantTypes: string[];
  let oauthTokenRedirectUris: string[];
  let oauthRefreshTokens: string[];

  beforeEach(() => {
    oauthUserOpenId = "ou_oauth_user";
    mockEnv("APP_URL", APP_ORIGIN);
    mockEnv("VM0_API_BACKEND_URL", "https://api.vm0.test");
    mockEnv("VM0_WEB_URL", "https://www.vm0.test");
    mockEnv("FEISHU_CALLBACK_BASE_URL", "https://www.vm0.test");
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
    context.mocks.axiom.query.mockResolvedValue([]);
    context.mocks.ably.publish.mockResolvedValue(undefined);

    server.use(
      http.post(
        "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
        () => {
          return HttpResponse.json({
            code: 0,
            tenant_access_token: "tenant-access-token",
            expire: 7200,
          });
        },
      ),
      http.get("https://open.feishu.cn/open-apis/bot/v3/info", () => {
        return HttpResponse.json({
          code: 0,
          bot: {
            open_id: BOT_OPEN_ID,
            app_name: "Okou Feishu",
            avatar_url: "https://example.com/okou-feishu.png",
          },
        });
      }),
      http.get("https://open.feishu.cn/open-apis/authen/v1/user_info", () => {
        return HttpResponse.json({
          code: 0,
          data: {
            name: "Feishu User",
            open_id: oauthUserOpenId,
            tenant_key: TENANT_KEY,
          },
        });
      }),
    );

    outboundMessages = [];
    addedReactions = [];
    removedReactions = [];
    historyMessages = [];
    failedSendTargets = [];
    oauthTokenExpiresInSeconds = 7200;
    oauthTokenGrantTypes = [];
    oauthTokenRedirectUris = [];
    oauthRefreshTokens = [];
    server.use(
      http.post(
        "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
        async ({ request }) => {
          const body: unknown = await request.json();
          if (
            typeof body !== "object" ||
            body === null ||
            !("grant_type" in body) ||
            typeof body.grant_type !== "string"
          ) {
            throw new Error("Expected Feishu OAuth grant type");
          }
          oauthTokenGrantTypes.push(body.grant_type);
          if (body.grant_type === "authorization_code") {
            if (
              !("redirect_uri" in body) ||
              typeof body.redirect_uri !== "string"
            ) {
              throw new Error("Expected Feishu OAuth redirect URI");
            }
            oauthTokenRedirectUris.push(body.redirect_uri);
          } else if (body.grant_type === "refresh_token") {
            if (
              !("refresh_token" in body) ||
              typeof body.refresh_token !== "string"
            ) {
              throw new Error("Expected Feishu OAuth refresh token");
            }
            oauthRefreshTokens.push(body.refresh_token);
          }
          return HttpResponse.json({
            code: 0,
            access_token:
              body.grant_type === "refresh_token"
                ? "feishu-refreshed-access-token"
                : "feishu-user-access-token",
            refresh_token:
              body.grant_type === "refresh_token"
                ? "feishu-rotated-refresh-token"
                : "feishu-user-refresh-token",
            expires_in:
              body.grant_type === "refresh_token"
                ? 7200
                : oauthTokenExpiresInSeconds,
          });
        },
      ),
      http.post(
        "https://open.feishu.cn/open-apis/im/v1/messages/:messageId/reply",
        async ({ params, request }) => {
          const body = (await request.json()) as FeishuMessageRequestBody;
          outboundMessages.push({
            kind: "reply",
            target: String(params.messageId),
            msgType: body.msg_type,
            content: JSON.parse(body.content) as Readonly<
              Record<string, unknown>
            >,
            replyInThread: body.reply_in_thread ?? false,
          });
          return HttpResponse.json({
            code: 0,
            msg: "success",
            data: {
              message_id: `om_reply_${randomUUID()}`,
              chat_id: "oc_feishu_dm",
            },
          });
        },
      ),
      http.post(
        "https://open.feishu.cn/open-apis/im/v1/messages",
        async ({ request }) => {
          const body = (await request.json()) as FeishuMessageRequestBody;
          const failedTargetIndex = failedSendTargets.indexOf(
            body.receive_id ?? "",
          );
          if (failedTargetIndex !== -1) {
            failedSendTargets.splice(failedTargetIndex, 1);
            return HttpResponse.json({
              code: 1,
              msg: "temporary message failure",
            });
          }
          outboundMessages.push({
            kind: "send",
            target: body.receive_id ?? "",
            msgType: body.msg_type,
            content: JSON.parse(body.content) as Readonly<
              Record<string, unknown>
            >,
            replyInThread: false,
          });
          return HttpResponse.json({
            code: 0,
            msg: "success",
            data: {
              message_id: `om_send_${randomUUID()}`,
              chat_id: "oc_feishu_dm",
            },
          });
        },
      ),
      http.get("https://open.feishu.cn/open-apis/im/v1/messages", () => {
        return HttpResponse.json({
          code: 0,
          data: { items: historyMessages, has_more: false },
        });
      }),
      http.post(
        "https://open.feishu.cn/open-apis/im/v1/messages/:messageId/reactions",
        ({ params }) => {
          addedReactions.push(String(params.messageId));
          return HttpResponse.json({
            code: 0,
            data: { reaction_id: `reaction_${randomUUID()}` },
          });
        },
      ),
      http.delete(
        "https://open.feishu.cn/open-apis/im/v1/messages/:messageId/reactions/:reactionId",
        ({ params }) => {
          removedReactions.push(String(params.messageId));
          return HttpResponse.json({ code: 0 });
        },
      ),
    );
  });

  async function setupFeishuRunFixture(
    options: { readonly useAlternateInstallationDefault?: boolean } = {},
  ): Promise<FeishuRunFixture> {
    const appId = `cli_${randomUUID()}`;
    const actor = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      orgRole: "org:admin",
    });
    const runnerGroup = runsApi.configureRunnerGroup();
    await enableFeishuIntegration(actor, {
      [FeatureSwitchKey.ZeroDebug]: true,
    });
    authOrgApi.acceptAgentStorageWrites();
    runsApi.acceptStorageDownloads();
    runsApi.acceptTelemetryIngest();
    const defaultAgentBootstrap =
      await authOrgApi.bootstrapLimitedFreeOnboarding(actor, {
        displayName: "Feishu default agent",
      });
    const defaultAgent = await authOrgApi.updateAgentMetadata(
      actor,
      defaultAgentBootstrap.body.agentId,
      { visibility: "public" },
    );
    const alternateAgent = await authOrgApi.createAgent(actor, {
      displayName: "Feishu alternate agent",
      visibility: "public",
    });
    const installationDefaultAgent = options.useAlternateInstallationDefault
      ? alternateAgent
      : defaultAgent;
    const otherAgent = options.useAlternateInstallationDefault
      ? defaultAgent
      : alternateAgent;
    await runsApi.grantProEntitlement(actor);
    await runsApi.ensureOrgModelProvider(actor);
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    const client = setupApp({ context })(zeroFeishuConnectContract);
    const configured = await accept(
      client.setup({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          appId,
          appSecret: APP_SECRET,
          verificationToken: VERIFICATION_TOKEN,
          encryptKey: ENCRYPT_KEY,
          defaultAgentId: installationDefaultAgent.agentId,
        },
      }),
      [200],
    );
    const callbackUrl = requireValue(
      configured.body.callbackUrl,
      "Expected Feishu setup to return a callback URL",
    );
    const installationId = requireValue(
      configured.body.installationId,
      "Expected Feishu setup to return an installation ID",
    );
    await accept(
      client.updateInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId },
        body: {
          defaultAgentId: installationDefaultAgent.agentId,
          setupCompleted: true,
        },
      }),
      [200],
    );
    await postEvent(
      callbackUrl,
      {
        type: "url_verification",
        challenge: "configured",
        token: VERIFICATION_TOKEN,
      },
      { encrypted: true },
    );
    context.mocks.ably.publish.mockClear();
    return {
      actor,
      runnerGroup,
      appId,
      callbackUrl,
      installationId,
      defaultAgentId: installationDefaultAgent.agentId,
      alternateAgentId: otherAgent.agentId,
    };
  }

  async function feishuAuthorizationUrlFromResponse(
    response: Response,
  ): Promise<URL> {
    expect(response.status).toBe(200);
    const responseBody: unknown = await response.json();
    if (
      typeof responseBody !== "object" ||
      responseBody === null ||
      !("openUrl" in responseBody) ||
      typeof responseBody.openUrl !== "string"
    ) {
      throw new Error("Expected Feishu OAuth authorization URL");
    }
    const authorizationUrl = new URL(responseBody.openUrl);
    expect(authorizationUrl.origin).toBe("https://accounts.feishu.cn");
    return authorizationUrl;
  }

  async function completeFeishuAuthorization(
    authorizationUrl: URL,
    openId: string,
  ): Promise<URL> {
    const state = requireValue(
      authorizationUrl.searchParams.get("state"),
      "Expected Feishu OAuth state",
    );
    oauthUserOpenId = openId;
    const oauthApp = createAppWithRoutes({
      signal: context.signal,
      routes: zeroFeishuOauthRoutes,
    });
    const callbackResponse = await oauthApp.request(
      `${zeroFeishuOauthContract.callback.path}?${new URLSearchParams({
        code: `feishu-oauth-${randomUUID()}`,
        responseMode: "json",
        state,
      })}`,
    );
    expect(callbackResponse.status).toBe(200);
    const responseBody: unknown = await callbackResponse.json();
    if (
      typeof responseBody !== "object" ||
      responseBody === null ||
      !("redirectUrl" in responseBody) ||
      typeof responseBody.redirectUrl !== "string"
    ) {
      throw new Error("Expected Feishu OAuth completion URL");
    }
    return new URL(responseBody.redirectUrl);
  }

  async function connectFixtureUser(
    fixture: FeishuRunFixture,
    actor = fixture.actor,
    openId = "ou_feishu_user",
  ): Promise<void> {
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    await postEvent(
      fixture.callbackUrl,
      directMessage(fixture.appId, "connect this Feishu user", openId),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const loginReply = requireValue(
      outboundMessages.find((message) => {
        return (
          message.kind === "send" &&
          messageContent(message).includes("Connect your account")
        );
      }),
      "Expected Feishu login reply",
    );
    const connectUrl = requireValue(
      messageContent(loginReply).match(/https:\/\/[^"]+/u)?.[0],
      "Expected Feishu connect URL",
    );
    const connectApp = createAppWithRoutes({
      signal: context.signal,
      routes: zeroFeishuBrowserConnectRoutes,
    });
    const response = await connectApp.request("/api/zero/feishu/connect", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "__session=opaque",
      },
      body: JSON.stringify(feishuConnectBody(connectUrl)),
    });
    const authorizationUrl = await feishuAuthorizationUrlFromResponse(response);
    const completionUrl = await completeFeishuAuthorization(
      authorizationUrl,
      openId,
    );
    expect(completionUrl.toString()).toBe(
      `https://applink.feishu.cn/client/bot/open?appId=${fixture.appId}`,
    );
    const connectBody = feishuConnectBody(connectUrl);
    const statusResponse = await connectApp.request(
      `/api/zero/feishu/connect/status?${new URLSearchParams(
        Object.entries(connectBody).map(([key, value]) => {
          return [key, String(value)];
        }),
      )}`,
      {
        headers: { cookie: "__session=opaque" },
      },
    );
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toMatchObject({
      isConnected: true,
    });
    outboundMessages = [];
  }

  async function completeRunSession(args: {
    readonly runId: string;
    readonly sandboxToken: string;
    readonly sessionId: string;
    readonly history: string;
    readonly assistantText: string;
  }): Promise<void> {
    const historyHash = createHash("sha256").update(args.history).digest("hex");
    const historySize = Buffer.byteLength(args.history, "utf8");
    const headers = {
      authorization: `Bearer ${args.sandboxToken}`,
    };
    await webhooksApi.requestAgentCheckpointPrepareHistory(
      {
        runId: args.runId,
        hash: historyHash,
        rawSize: historySize,
        encodedSize: historySize,
        encoding: "identity",
      },
      headers,
      [200],
    );
    await webhooksApi.requestAgentCheckpoint(
      {
        runId: args.runId,
        cliAgentType: "claude-code",
        cliAgentSessionId: args.sessionId,
        cliAgentSessionHistoryHash: historyHash,
      },
      headers,
      [200],
    );
    const assistantEvent = {
      type: "assistant" as const,
      sequenceNumber: 0,
      message: {
        id: `msg_bdd_feishu_${args.runId}`,
        content: [{ type: "text" as const, text: args.assistantText }],
      },
    };
    chatCallbacks.mockChatOutputEvents([
      {
        eventType: assistantEvent.type,
        sequenceNumber: assistantEvent.sequenceNumber,
        eventData: { message: assistantEvent.message },
      },
    ]);
    await webhooksApi.requestAgentEvents(
      { runId: args.runId, events: [assistantEvent] },
      headers,
      [200],
    );
    await webhooksApi.requestAgentComplete(
      { runId: args.runId, exitCode: 0, lastEventSequence: 0 },
      headers,
      [200],
    );
    await flushWaitUntilForTest();
    chatCallbacks.mockChatOutputEvents([]);
  }

  async function findRun(
    actor: ApiTestUser,
    prompt: string,
  ): Promise<
    Awaited<ReturnType<typeof runsApi.listAgentRuns>>["runs"][number]
  > {
    const listed = await runsApi.listAgentRuns(actor, { limit: 20 });
    return requireValue(
      listed.runs.find((candidate) => {
        return candidate.prompt === prompt;
      }),
      `Expected Feishu run for prompt: ${prompt}`,
    );
  }

  it("rejects configuration API access when the feature switch is disabled", async () => {
    const actor = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      orgRole: "org:admin",
    });
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    const client = setupApp({ context })(zeroFeishuConnectContract);

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body.error).toStrictEqual({
      code: "FORBIDDEN",
      message: "Feishu integration is not enabled",
    });
  });

  it("uses the public callback origin and accepts plaintext URL verification without an Encrypt Key", async () => {
    const callbackOrigin = "https://tunnel-feishu.vm0.test";
    mockEnv("FEISHU_CALLBACK_BASE_URL", callbackOrigin);
    const appId = `cli_${randomUUID()}`;
    const actor = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      orgRole: "org:admin",
    });
    authOrgApi.acceptAgentStorageWrites();
    await enableFeishuIntegration(actor);
    const agent = await authOrgApi.createAgent(actor, {
      displayName: "Feishu plaintext callback agent",
      visibility: "public",
    });
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    const client = setupApp({ context })(zeroFeishuConnectContract);
    const configured = await accept(
      client.setup({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          appId,
          appSecret: APP_SECRET,
          verificationToken: VERIFICATION_TOKEN,
          defaultAgentId: agent.agentId,
        },
      }),
      [200],
    );
    const callbackUrl = configured.body.callbackUrl;
    expect(callbackUrl).not.toBeNull();
    if (!callbackUrl) {
      throw new Error("Expected Feishu setup to return a callback URL");
    }
    expect(new URL(callbackUrl).origin).toBe(callbackOrigin);

    const response = await postEvent(
      callbackUrl,
      {
        type: "url_verification",
        challenge: "plaintext-challenge",
        token: VERIFICATION_TOKEN,
      },
      { signed: false },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      challenge: "plaintext-challenge",
    });
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "feishu:changed",
      null,
    );

    await accept(
      client.remove({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
  });

  it("keeps one Feishu app installed per organization", async () => {
    const firstAppId = `cli_${randomUUID()}`;
    const secondAppId = `cli_${randomUUID()}`;
    const actor = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      orgRole: "org:admin",
    });
    authOrgApi.acceptAgentStorageWrites();
    await enableFeishuIntegration(actor);
    const agent = await authOrgApi.createAgent(actor, {
      displayName: "Feishu single-bot agent",
      visibility: "public",
    });
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    const client = setupApp({ context })(zeroFeishuConnectContract);

    await accept(
      client.setup({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          appId: firstAppId,
          appSecret: APP_SECRET,
          verificationToken: VERIFICATION_TOKEN,
          defaultAgentId: agent.agentId,
          createNew: true,
        },
      }),
      [200],
    );
    await accept(
      client.setup({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          appId: firstAppId,
          appSecret: APP_SECRET,
          verificationToken: VERIFICATION_TOKEN,
          defaultAgentId: agent.agentId,
        },
      }),
      [200],
    );
    const secondSetup = await accept(
      client.setup({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          appId: secondAppId,
          appSecret: APP_SECRET,
          verificationToken: VERIFICATION_TOKEN,
          defaultAgentId: agent.agentId,
          createNew: true,
        },
      }),
      [409],
    );
    expect(secondSetup.body.error.message).toBe(
      "This workspace already has a Feishu bot",
    );
    await accept(
      client.checkAppId({
        headers: { authorization: "Bearer clerk-session" },
        query: { appId: firstAppId },
      }),
      [409],
    );
    await accept(
      client.checkAppId({
        headers: { authorization: "Bearer clerk-session" },
        query: { appId: `cli_${randomUUID()}` },
      }),
      [200],
    );

    const status = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(status.body.installations).toHaveLength(1);
    expect(
      status.body.installations?.map((installation) => {
        return installation.appId;
      }),
    ).toStrictEqual([firstAppId]);
    const installation = status.body.installations?.[0];
    if (!installation) {
      throw new Error("Expected one Feishu installation");
    }
    await accept(
      client.removeInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId: installation.id },
      }),
      [200],
    );
  });

  it("serializes concurrent Feishu app creation per organization", async () => {
    const actor = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      orgRole: "org:admin",
    });
    authOrgApi.acceptAgentStorageWrites();
    await enableFeishuIntegration(actor);
    const agent = await authOrgApi.createAgent(actor, {
      displayName: "Feishu concurrent setup agent",
      visibility: "public",
    });
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    const client = setupApp({ context })(zeroFeishuConnectContract);
    const bothTokenRequestsStarted = createDeferredPromise<void>(
      context.signal,
    );
    const releaseTokenRequests = createDeferredPromise<void>(context.signal);
    let tokenRequestCount = 0;
    server.use(
      http.post(
        "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
        async () => {
          tokenRequestCount += 1;
          if (tokenRequestCount === 2) {
            bothTokenRequestsStarted.resolve();
          }
          await releaseTokenRequests.promise;
          return HttpResponse.json({
            code: 0,
            tenant_access_token: "tenant-access-token",
            expire: 7200,
          });
        },
      ),
    );

    const setupResponsesPromise = Promise.all(
      [`cli_${randomUUID()}`, `cli_${randomUUID()}`].map((appId) => {
        return client.setup({
          headers: { authorization: "Bearer clerk-session" },
          body: {
            appId,
            appSecret: APP_SECRET,
            verificationToken: VERIFICATION_TOKEN,
            defaultAgentId: agent.agentId,
            createNew: true,
          },
        });
      }),
    );
    await bothTokenRequestsStarted.promise;
    releaseTokenRequests.resolve();
    const setupResponses = await setupResponsesPromise;

    expect(
      setupResponses.map((response) => {
        return response.status;
      }),
    ).toContain(200);
    expect(
      setupResponses.map((response) => {
        return response.status;
      }),
    ).toContain(409);

    const status = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(status.body.installations).toHaveLength(1);
    const installation = status.body.installations?.[0];
    if (!installation) {
      throw new Error("Expected one Feishu installation");
    }
    await accept(
      client.removeInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId: installation.id },
      }),
      [200],
    );
  });

  it("requires organization admins even when the user created the bot", async () => {
    const actor = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      orgRole: "org:admin",
    });
    authOrgApi.acceptAgentStorageWrites();
    await enableFeishuIntegration(actor);
    const agent = await authOrgApi.createAgent(actor, {
      displayName: "Feishu managed bot agent",
      visibility: "public",
    });
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    const client = setupApp({ context })(zeroFeishuConnectContract);

    const configured = await accept(
      client.setup({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          appId: `cli_${randomUUID()}`,
          appSecret: APP_SECRET,
          verificationToken: VERIFICATION_TOKEN,
          defaultAgentId: agent.agentId,
          createNew: true,
        },
      }),
      [200],
    );
    const installationId = configured.body.installationId;
    if (!installationId) {
      throw new Error("Expected one Feishu installation");
    }

    mocks.clerk.session(actor.userId, actor.orgId, "org:member");
    const memberStatus = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(memberStatus.body.isAdmin).toBeFalsy();
    await accept(
      client.checkAppId({
        headers: { authorization: "Bearer clerk-session" },
        query: { appId: `cli_${randomUUID()}` },
      }),
      [403],
    );
    await accept(
      client.setup({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          appId: `cli_${randomUUID()}`,
          appSecret: APP_SECRET,
          verificationToken: VERIFICATION_TOKEN,
          defaultAgentId: agent.agentId,
          createNew: true,
        },
      }),
      [403],
    );
    await accept(
      client.updateInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId },
        body: { defaultAgentId: agent.agentId, setupCompleted: true },
      }),
      [403],
    );
    await accept(
      client.removeInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId },
      }),
      [403],
    );

    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    const completed = await accept(
      client.updateInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId },
        body: {
          defaultAgentId: agent.agentId,
          setupCompleted: true,
        },
      }),
      [200],
    );
    expect(completed.body.setupCompleted).toBeTruthy();
    expect(completed.body.botName).toBe("Okou Feishu");
    expect(completed.body.botAvatarUrl).toBe(
      "https://example.com/okou-feishu.png",
    );
    await accept(
      client.removeInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId },
      }),
      [200],
    );
  });

  it("connects the current Feishu user through signed OAuth state", async () => {
    const appId = `cli_${randomUUID()}`;
    const admin = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      orgRole: "org:admin",
    });
    const member = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: admin.orgId,
      orgRole: "org:member",
    });
    authOrgApi.acceptAgentStorageWrites();
    await enableFeishuIntegration(admin);
    await enableFeishuIntegration(member);
    const agent = await authOrgApi.createAgent(admin, {
      displayName: "Feishu OAuth agent",
      visibility: "public",
    });
    mocks.clerk.session(admin.userId, admin.orgId, "org:admin");
    const client = setupApp({ context })(zeroFeishuConnectContract);
    const configured = await accept(
      client.setup({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          appId,
          appSecret: APP_SECRET,
          verificationToken: VERIFICATION_TOKEN,
          defaultAgentId: agent.agentId,
          createNew: true,
        },
      }),
      [200],
    );
    const installationId = configured.body.installationId;
    if (!installationId) {
      throw new Error("Expected Feishu setup to return an installation id");
    }
    await accept(
      client.updateInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId },
        body: {
          defaultAgentId: agent.agentId,
          setupCompleted: true,
        },
      }),
      [200],
    );

    const customConnectorClient = setupApp({ context })(
      zeroCustomConnectorsContract,
    );
    const connectorList = await accept(
      customConnectorClient.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(connectorList.body.connectors).toHaveLength(1);
    const managedConnector = requireValue(
      connectorList.body.connectors[0],
      "Expected setup to create a managed Feishu custom connector",
    );
    expect(managedConnector).toMatchObject({
      slug: `_feishu-${installationId}`,
      displayName: "Feishu-Okou Feishu",
      prefixes: ["https://open.feishu.cn/open-apis/"],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{oauth.access_token}}",
        },
      ],
      authMode: "oauth",
      connected: false,
      oauthConfig: {
        providerAdapter: "feishu",
        clientId: appId,
        authorizationUrl:
          "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
        tokenUrl: "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
        tokenEndpointAuthMethod: "client_secret_post",
        pkceMethod: "none",
        scopes: [...EXPECTED_FEISHU_OAUTH_SCOPES],
      },
    });
    expect(managedConnector.skillMarkdown).toContain("Available capabilities");
    expect(managedConnector.skillMarkdown).toContain(
      "Every request runs with the connected user's identity",
    );
    expect(managedConnector.skillMarkdown).toContain(
      "does not grant whiteboard node update or delete scopes",
    );
    const skillMarkdown = uploadedSkillMarkdown();
    expect(skillMarkdown).toContain("---\nname: feishu\n");
    expect(skillMarkdown).toContain(
      "description: Feishu OpenAPI for user-authorized messaging, people search, cloud",
    );
    expect(skillMarkdown).toContain(
      "documents, calendars, and tasks. Use when the user asks to work with Feishu.",
    );
    expect(skillMarkdown).not.toContain("Okou Feishu");
    expect(skillMarkdown).not.toContain(managedConnector.id);

    const customConnectorOAuthClient = setupApp({ context })(
      zeroCustomConnectorOAuth2Contract,
    );
    const customConnectorOAuthStart = await accept(
      customConnectorOAuthClient.start({
        headers: { authorization: "Bearer clerk-session" },
        params: { id: managedConnector.id },
        body: {},
      }),
      [200],
    );
    const customAuthorizationUrl = new URL(
      customConnectorOAuthStart.body.authorizationUrl,
    );
    expect(customAuthorizationUrl.searchParams.get("redirect_uri")).toBe(
      `${APP_ORIGIN}/connectors/feishu/callback`,
    );
    oauthUserOpenId = "ou_custom_connector_user";
    const customOAuthState = requireValue(
      customAuthorizationUrl.searchParams.get("state"),
      "Expected custom connector Feishu OAuth state",
    );
    const oauthApp = createAppWithRoutes({
      signal: context.signal,
      routes: zeroFeishuOauthRoutes,
    });
    const customConnectorCallback = await oauthApp.request(
      `${zeroFeishuOauthContract.callback.path}?${new URLSearchParams({
        code: "feishu-custom-connector-code",
        responseMode: "json",
        state: customOAuthState,
      })}`,
    );
    expect(customConnectorCallback.status).toBe(200);
    await expect(customConnectorCallback.json()).resolves.toStrictEqual({
      redirectUrl: `${APP_ORIGIN}/connectors/custom/callback/success`,
    });
    await flushWaitUntilForTest();
    const connectedFromCustomConnector = await accept(
      customConnectorClient.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(connectedFromCustomConnector.body.connectors[0]).toMatchObject({
      id: managedConnector.id,
      connected: true,
    });
    const adminFeishuStatus = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(adminFeishuStatus.body).toMatchObject({
      isConnected: true,
      connectedUserName: "Feishu User",
    });
    await accept(
      setupApp({ context })(zeroCustomConnectorSecretContract).delete({
        headers: { authorization: "Bearer clerk-session" },
        params: { id: managedConnector.id },
      }),
      [204],
    );
    const disconnectedFromCustomConnector = await accept(
      customConnectorClient.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(disconnectedFromCustomConnector.body.connectors[0]).toMatchObject({
      id: managedConnector.id,
      connected: false,
    });
    const disconnectedAdminFeishuStatus = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(disconnectedAdminFeishuStatus.body.isConnected).toBeFalsy();
    oauthTokenRedirectUris = [];
    oauthUserOpenId = "ou_oauth_user";
    outboundMessages = [];

    mocks.clerk.session(member.userId, member.orgId, "org:member");
    mockClerkMembership(context, member, "org:member");
    const status = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const connectUrl = status.body.installations?.[0]?.connectUrl;
    expect(connectUrl).toBeDefined();
    expect(status.body.oauthRedirectUrl).toBe(
      `${APP_ORIGIN}/connectors/feishu/callback`,
    );
    expect(status.body.oauthScopes).toStrictEqual([
      ...EXPECTED_FEISHU_OAUTH_SCOPES,
    ]);
    if (!connectUrl) {
      throw new Error("Expected Feishu status to return an OAuth connect URL");
    }
    expect(new URL(connectUrl).origin).toBe("https://api.vm0.test");

    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const legacyConnectResponse = await oauthApp.request(connectUrl);
    expect(legacyConnectResponse.status).toBe(307);
    expect(
      new URL(
        legacyConnectResponse.headers.get("location") ?? "",
      ).searchParams.get("redirect_uri"),
    ).toBe("https://www.vm0.test/api/zero/feishu/oauth/callback");

    const appConnectUrl = new URL(connectUrl);
    appConnectUrl.searchParams.set("callbackTarget", "app");
    const connectResponse = await oauthApp.request(appConnectUrl);
    expect(connectResponse.status).toBe(307);
    const authorizationUrl = new URL(
      connectResponse.headers.get("location") ?? "",
    );
    expect(authorizationUrl.origin).toBe("https://accounts.feishu.cn");
    expect(authorizationUrl.searchParams.get("client_id")).toBe(appId);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      `${APP_ORIGIN}/connectors/feishu/callback`,
    );
    expect(
      authorizationUrl.searchParams.get("scope")?.split(" "),
    ).toStrictEqual([...EXPECTED_FEISHU_OAUTH_SCOPES]);
    const state = authorizationUrl.searchParams.get("state");
    if (!state) {
      throw new Error("Expected Feishu authorization URL to include state");
    }

    const handoffResponse = await oauthApp.request(
      `${zeroFeishuOauthContract.callback.path}?${new URLSearchParams({
        code: "feishu-oauth-code",
        state,
      })}`,
    );
    expect(handoffResponse.status).toBe(307);
    const handoffUrl = new URL(handoffResponse.headers.get("location") ?? "");
    expect(handoffUrl.origin).toBe(APP_ORIGIN);
    expect(handoffUrl.pathname).toBe("/connectors/feishu/callback");
    expect(handoffUrl.searchParams.get("code")).toBe("feishu-oauth-code");
    expect(handoffUrl.searchParams.get("state")).toBe(state);

    const callbackResponse = await oauthApp.request(
      `${zeroFeishuOauthContract.callback.path}?${new URLSearchParams({
        code: "feishu-oauth-code",
        responseMode: "json",
        state,
      })}`,
    );
    expect(callbackResponse.status).toBe(200);
    await expect(callbackResponse.json()).resolves.toStrictEqual({
      redirectUrl: `https://applink.feishu.cn/client/bot/open?appId=${appId}`,
    });
    expect(oauthTokenRedirectUris).toStrictEqual([
      `${APP_ORIGIN}/connectors/feishu/callback`,
    ]);

    const legacyCallbackResponse = await oauthApp.request(
      `${zeroFeishuOauthContract.callback.path}?${new URLSearchParams({
        code: "legacy-feishu-oauth-code",
        responseMode: "json",
        state: legacyFeishuAppOAuthState({
          installationId,
          orgId: requireValue(member.orgId, "Expected an organization"),
          userId: member.userId,
        }),
      })}`,
    );
    expect(legacyCallbackResponse.status).toBe(200);
    expect(oauthTokenRedirectUris).toStrictEqual([
      `${APP_ORIGIN}/connectors/feishu/callback`,
      "https://www.vm0.test/api/zero/feishu/oauth/callback",
    ]);
    await flushWaitUntilForTest();

    mocks.clerk.session(member.userId, member.orgId, member.orgRole);
    const connected = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(connected.body.installations?.[0]?.isConnected).toBeTruthy();
    expect(connected.body.installations?.[0]?.connectedUserName).toBe(
      "Feishu User",
    );
    const connectedConnectorList = await accept(
      customConnectorClient.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(connectedConnectorList.body.connectors).toMatchObject([
      {
        id: managedConnector.id,
        connected: true,
        hasSecret: true,
      },
    ]);
    const welcome = outboundMessages.find((message) => {
      return (
        message.kind === "send" &&
        message.target === "ou_oauth_user" &&
        messageContent(message).includes("You're connected!")
      );
    });
    expect(welcome?.msgType).toBe("interactive");

    mocks.clerk.session(admin.userId, admin.orgId, admin.orgRole);
    await accept(
      client.removeInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId },
      }),
      [200],
    );
    const removedConnectorList = await accept(
      customConnectorClient.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(removedConnectorList.body.connectors).toStrictEqual([]);
  });

  it("verifies and decrypts URL verification callbacks", async () => {
    const appId = `cli_${randomUUID()}`;
    const actor = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      orgRole: "org:admin",
    });
    authOrgApi.acceptAgentStorageWrites();
    await enableFeishuIntegration(actor);
    const agent = await authOrgApi.createAgent(actor, {
      displayName: "Feishu callback agent",
      visibility: "public",
    });
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    const client = setupApp({ context })(zeroFeishuConnectContract);
    const configured = await accept(
      client.setup({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          appId,
          appSecret: APP_SECRET,
          verificationToken: VERIFICATION_TOKEN,
          encryptKey: ENCRYPT_KEY,
          defaultAgentId: agent.agentId,
        },
      }),
      [200],
    );
    const callbackUrl = configured.body.callbackUrl;
    expect(callbackUrl).not.toBeNull();
    if (!callbackUrl) {
      throw new Error("Expected Feishu setup to return a callback URL");
    }
    const payload = {
      type: "url_verification",
      challenge: "challenge-value",
      token: VERIFICATION_TOKEN,
    };

    const plaintextResponse = await postEvent(callbackUrl, payload, {
      signed: false,
    });
    expect(plaintextResponse.status).toBe(200);
    await expect(plaintextResponse.json()).resolves.toStrictEqual({
      challenge: "challenge-value",
    });

    const response = await postEvent(callbackUrl, payload, {
      encrypted: true,
      signed: false,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      challenge: "challenge-value",
    });

    const event = v2Event(appId, "unknown.event", {});
    const rejected = await postEvent(callbackUrl, event, {
      encrypted: true,
      validSignature: false,
    });
    expect(rejected.status).toBe(401);

    const stale = await postEvent(callbackUrl, event, {
      encrypted: true,
      timestamp: 0,
    });
    expect(stale.status).toBe(401);
    const status = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(status.body.callbackVerified).toBeTruthy();
    await accept(
      client.remove({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
  });

  it("backfills bot identity before handling a group mention", async () => {
    const appId = `cli_${randomUUID()}`;
    const actor = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      orgRole: "org:admin",
    });
    authOrgApi.acceptAgentStorageWrites();
    await enableFeishuIntegration(actor);
    const agent = await authOrgApi.createAgent(actor, {
      displayName: "Feishu compatibility agent",
      visibility: "public",
    });
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    const client = setupApp({ context })(zeroFeishuConnectContract);
    const configured = await accept(
      client.setup({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          appId,
          appSecret: APP_SECRET,
          verificationToken: VERIFICATION_TOKEN,
          encryptKey: ENCRYPT_KEY,
          defaultAgentId: agent.agentId,
        },
      }),
      [200],
    );
    const callbackUrl = configured.body.callbackUrl;
    if (!callbackUrl) {
      throw new Error("Expected Feishu callback URL");
    }

    await postEvent(
      callbackUrl,
      groupMessage(appId, "group task after upgrade"),
      { encrypted: true },
    );
    await flushWaitUntilForTest();

    const loginReply = outboundMessages.find((message) => {
      return (
        message.kind === "reply" &&
        messageContent(message).includes("Connect your account")
      );
    });
    expect(loginReply?.replyInThread).toBeTruthy();
    const status = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(status.body.installations?.[0]?.botName).toBe("Okou Feishu");

    await accept(
      client.remove({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
  });

  it("retries a durably admitted Feishu event after dispatch fails", async () => {
    const fixture = await setupFeishuRunFixture();
    const { appId, callbackUrl } = fixture;
    const event = directMessage(appId, "retry this Feishu event");
    failedSendTargets.push("oc_feishu_dm");

    const firstResponse = await postEvent(callbackUrl, event, {
      encrypted: true,
    });
    expect(firstResponse.status).toBe(200);
    await flushWaitUntilForTest();
    expect(outboundMessages).toHaveLength(0);

    const retryResponse = await postEvent(callbackUrl, event, {
      encrypted: true,
    });
    expect(retryResponse.status).toBe(200);
    await flushWaitUntilForTest();
    const loginReplies = outboundMessages.filter((message) => {
      return messageContent(message).includes("Connect your account");
    });
    expect(loginReplies).toHaveLength(1);
  });

  it("deduplicates unconnected messages, connects, welcomes, and rejects account rebinding", async () => {
    const fixture = await setupFeishuRunFixture();
    const { actor, appId, callbackUrl, defaultAgentId } = fixture;
    const client = setupApp({ context })(zeroFeishuConnectContract);

    const firstEvent = directMessage(appId, "hello");
    const firstMessage = await postEvent(callbackUrl, firstEvent, {
      encrypted: true,
    });
    const duplicateMessage = await postEvent(callbackUrl, firstEvent, {
      encrypted: true,
    });
    expect(firstMessage.status).toBe(200);
    expect(duplicateMessage.status).toBe(200);
    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "feishu:changed",
      null,
    );
    const loginReplies = outboundMessages.filter((message) => {
      return message.kind === "send";
    });
    expect(loginReplies).toHaveLength(1);
    const firstReply = loginReplies[0];
    expect(firstReply?.target).toBe("oc_feishu_dm");
    expect(firstReply?.msgType).toBe("interactive");
    const firstReplyContent = firstReply ? messageContent(firstReply) : "";
    expect(firstReplyContent).toContain("Connect your account");
    expect(firstReplyContent).toContain(
      "To use Zero in Feishu, please connect your account first.",
    );
    const connectUrl = requireValue(
      firstReplyContent.match(/https:\/\/[^"]+/u)?.[0],
      "Expected Feishu to send a connect URL",
    );
    expect(`${new URL(connectUrl).origin}${new URL(connectUrl).pathname}`).toBe(
      `${APP_ORIGIN}/settings/feishu`,
    );

    const connectApp = createAppWithRoutes({
      signal: context.signal,
      routes: zeroFeishuBrowserConnectRoutes,
    });
    failedSendTargets.push("ou_feishu_user");
    context.mocks.ably.publish.mockClear();
    const connectResponse = await connectApp.request(
      "/api/zero/feishu/connect",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "__session=opaque",
        },
        body: JSON.stringify(feishuConnectBody(connectUrl)),
      },
    );
    const authorizationUrl =
      await feishuAuthorizationUrlFromResponse(connectResponse);
    expect(
      authorizationUrl.searchParams.get("scope")?.split(" "),
    ).toStrictEqual([...EXPECTED_FEISHU_OAUTH_SCOPES]);
    const completionUrl = await completeFeishuAuthorization(
      authorizationUrl,
      "ou_feishu_user",
    );
    expect(completionUrl.toString()).toBe(
      `https://applink.feishu.cn/client/bot/open?appId=${appId}`,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "feishu:changed",
      null,
    );
    const connectedStatus = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(connectedStatus.body.installations?.[0]?.connectedUserName).toBe(
      "Feishu User",
    );
    await flushWaitUntilForTest();
    expect(
      outboundMessages.some((message) => {
        return (
          message.target === "ou_feishu_user" &&
          messageContent(message).includes("You're connected!")
        );
      }),
    ).toBeFalsy();
    const retryConnectResponse = await connectApp.request(
      "/api/zero/feishu/connect",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "__session=opaque",
        },
        body: JSON.stringify(feishuConnectBody(connectUrl)),
      },
    );
    const retryAuthorizationUrl =
      await feishuAuthorizationUrlFromResponse(retryConnectResponse);
    await completeFeishuAuthorization(retryAuthorizationUrl, "ou_feishu_user");
    await flushWaitUntilForTest();
    const welcome = outboundMessages.find((message) => {
      return (
        message.kind === "send" &&
        message.target === "ou_feishu_user" &&
        messageContent(message).includes("You're connected!")
      );
    });
    expect(welcome?.msgType).toBe("interactive");
    expect(welcome ? messageContent(welcome) : "").toContain(
      "Feishu default agent",
    );

    const otherActor = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: actor.orgId,
      orgRole: "org:member",
    });
    mocks.clerk.session(otherActor.userId, otherActor.orgId, "org:member");
    const rebindResponse = await connectApp.request(
      "/api/zero/feishu/connect",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "__session=opaque",
        },
        body: JSON.stringify(feishuConnectBody(connectUrl)),
      },
    );
    const rebindAuthorizationUrl =
      await feishuAuthorizationUrlFromResponse(rebindResponse);
    const rebindCompletionUrl = await completeFeishuAuthorization(
      rebindAuthorizationUrl,
      "ou_feishu_user",
    );
    expect(rebindCompletionUrl.pathname).toBe("/settings/feishu");
    expect(rebindCompletionUrl.searchParams.get("error")).toBe(
      "This Feishu account is already connected.",
    );
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");

    outboundMessages = [];
    const replacementOpenId = "ou_feishu_replacement_user";
    await postEvent(
      callbackUrl,
      directMessage(appId, "connect replacement identity", replacementOpenId),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const replacementLogin = requireValue(
      outboundMessages.find((message) => {
        return messageContent(message).includes("Connect your account");
      }),
      "Expected replacement Feishu identity to receive a connect link",
    );
    const replacementConnectUrl = requireValue(
      messageContent(replacementLogin).match(/https:\/\/[^"]+/u)?.[0],
      "Expected replacement Feishu connect URL",
    );
    const legacyReplacementConnectUrl = new URL(
      "/api/zero/feishu/connect",
      "https://www.vm0.test",
    );
    legacyReplacementConnectUrl.search = new URL(replacementConnectUrl).search;
    const replacementResponse = await connectApp.request(
      legacyReplacementConnectUrl.toString(),
      {
        headers: { cookie: "__session=opaque" },
      },
    );
    expect(replacementResponse.status).toBe(307);
    const replacementAuthorizationUrl = new URL(
      requireValue(
        replacementResponse.headers.get("location"),
        "Expected replacement Feishu authorization URL",
      ),
    );
    expect(replacementAuthorizationUrl.origin).toBe(
      "https://accounts.feishu.cn",
    );
    await completeFeishuAuthorization(
      replacementAuthorizationUrl,
      replacementOpenId,
    );
    await flushWaitUntilForTest();

    outboundMessages = [];
    await postEvent(
      callbackUrl,
      directMessage(appId, "old identity should reconnect"),
      {
        encrypted: true,
      },
    );
    await postEvent(
      callbackUrl,
      directMessage(appId, "/help", replacementOpenId),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const replacementResults = outboundMessages.map(messageContent);
    expect(replacementResults).toStrictEqual(
      expect.arrayContaining([
        expect.stringContaining("Connect your account"),
        expect.stringContaining("Zero commands"),
      ]),
    );

    const status = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(status.body).toMatchObject({
      isInstalled: true,
      isConnected: true,
      isAdmin: true,
      appId,
      callbackVerified: true,
      messageReceived: true,
      tenantKey: TENANT_KEY,
      defaultAgentId,
    });
    await accept(
      client.removeInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId: fixture.installationId },
      }),
      [200],
    );
  });

  it("handles connected commands and disconnects the current user", async () => {
    const fixture = await setupFeishuRunFixture();
    const { appId, callbackUrl } = fixture;
    await connectFixtureUser(fixture);
    const client = setupApp({ context })(zeroFeishuConnectContract);
    for (const command of [
      "/help",
      "/connect",
      "/switch",
      "/model",
      "/unknown",
    ]) {
      await postEvent(callbackUrl, directMessage(appId, command), {
        encrypted: true,
      });
      await flushWaitUntilForTest();
    }
    const commandReplies = outboundMessages
      .filter((message) => {
        return message.kind === "send";
      })
      .map(messageContent);
    const helpReply = requireValue(
      outboundMessages.find((message) => {
        return messageContent(message).includes("Zero commands");
      }),
      "Expected Feishu help reply",
    );
    expect(helpReply.msgType).toBe("text");
    expect(
      commandReplies.some((content) => {
        return content.includes("Zero commands");
      }),
    ).toBeTruthy();
    expect(
      commandReplies.some((content) => {
        return content.includes("Already connected");
      }),
    ).toBeTruthy();
    expect(
      commandReplies.some((content) => {
        return content.includes("Choose an agent");
      }),
    ).toBeTruthy();
    expect(
      commandReplies.some((content) => {
        return content.includes("Choose a model");
      }),
    ).toBeTruthy();
    await postEvent(callbackUrl, directMessage(appId, "/disconnect"), {
      encrypted: true,
    });
    await flushWaitUntilForTest();
    expect(
      outboundMessages.some((message) => {
        return messageContent(message).includes("Disconnected");
      }),
    ).toBeTruthy();
    await postEvent(callbackUrl, directMessage(appId, "/disconnect"), {
      encrypted: true,
    });
    await flushWaitUntilForTest();
    expect(
      outboundMessages.some((message) => {
        return messageContent(message).includes("You are not connected.");
      }),
    ).toBeTruthy();
    const disconnectedStatus = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(disconnectedStatus.body).toMatchObject({
      isInstalled: true,
      isConnected: false,
    });
    await accept(
      client.removeInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId: fixture.installationId },
      }),
      [200],
    );
  });

  it("runs a Feishu DM file with downloadable resource context", async () => {
    const fixture = await setupFeishuRunFixture();
    const { actor, runnerGroup, appId, callbackUrl, defaultAgentId } = fixture;
    oauthTokenExpiresInSeconds = 0;
    await connectFixtureUser(fixture);
    const customConnectorClient = setupApp({ context })(
      zeroCustomConnectorsContract,
    );
    const connectorList = await accept(
      customConnectorClient.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const managedConnector = requireValue(
      connectorList.body.connectors[0],
      "Expected connected Feishu custom connector",
    );
    const fileKey = `file_v2_${"a".repeat(1400)}`;
    await postEvent(
      callbackUrl,
      directFileMessage(appId, {
        messageId: "om_file_message",
        fileKey,
        filename: "quarterly-report.pdf",
      }),
      { encrypted: true },
    );
    await flushWaitUntilForTest();

    const feishuFilePrompt = "[Feishu file] quarterly-report.pdf";
    const listed = await runsApi.listAgentRuns(actor, { limit: 20 });
    const run = requireValue(
      listed.runs.find((candidate) => {
        return candidate.prompt.includes(feishuFilePrompt);
      }),
      "Expected Feishu file run",
    );
    await runsApi.heartbeatRunner(runnerGroup);
    const claim = await runsApi.claimRunnerJob(run.id);
    expect(claim.prompt).toBe(run.prompt);
    expect(oauthTokenGrantTypes).toStrictEqual([
      "authorization_code",
      "refresh_token",
    ]);
    expect(oauthRefreshTokens).toStrictEqual(["feishu-user-refresh-token"]);
    const internalName = `custom_connector_${managedConnector.id.replaceAll(
      "-",
      "",
    )}`;
    expect(
      claim.firewalls?.find((entry) => {
        return entry.kind === "inline"
          ? entry.firewall.name === internalName
          : entry.name === internalName;
      }),
    ).toMatchObject({
      kind: "inline",
      firewall: {
        name: internalName,
        apis: [
          {
            base: "https://open.feishu.cn/open-apis/",
            auth: {
              headers: {
                Authorization: expect.stringContaining("secrets."),
              },
            },
          },
        ],
      },
    });
    expect(
      expectCanonicalStorageManifest(claim.storageManifest)?.storageMounts.some(
        (storage) => {
          return (
            storage.name ===
            getCustomConnectorSkillStorageName(managedConnector.id)
          );
        },
      ),
    ).toBeTruthy();
    expect(claim.prompt).toContain(feishuFilePrompt);
    expect(claim.prompt).toContain("   [MESSAGE_ID] om_file_message");
    expect(claim.prompt).toContain("   [TYPE] file");
    const fileId = claim.prompt.match(/ {3}\[FILE_KEY\] ([^\n]+)/u)?.[1];
    expect(fileId).toMatch(/^feishu_file_[A-Za-z0-9_-]{22}$/u);
    expect(fileId?.length).toBeLessThan(64);
    expect(claim.prompt).not.toContain(fileKey);
    expect(claim.prompt).toContain(`   [FILE_KEY] ${fileId}`);
    expect(claim.appendSystemPrompt).toContain("zero feishu download-file -h");
    expect(claim.appendSystemPrompt).toContain("zero feishu upload-file -h");

    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const threadEvents = await accept(
      setupApp({ context })(chatThreadsContract).events({
        headers: { authorization: "Bearer clerk-session" },
        query: {},
      }),
      [200],
    );
    const chatThreadCreated = requireValue(
      threadEvents.body.events.find((event) => {
        return event.kind === "created" && event.agentId === defaultAgentId;
      }),
      "Expected the canonical Feishu file chat thread",
    );
    const threadEventsPage = await accept(
      setupApp({ context })(chatThreadEventsContract).list({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: chatThreadCreated.chatThreadId },
        query: {},
      }),
      [200],
    );
    expect(threadEventsPage.body.events).toContainEqual(
      expect.objectContaining({
        content: null,
        userMessage: {
          version: 1,
          parts: [
            {
              type: "file",
              fileId,
              filenameSnapshot: "quarterly-report.pdf",
              contentType: "application/pdf",
            },
            {
              type: "source",
              kind: "feishu",
              href: "https://applink.feishu.cn/client/chat/open?openChatId=oc_feishu_dm",
            },
          ],
        },
      }),
    );

    const fileBytes = Buffer.from("feishu file bytes");
    server.use(
      http.get(
        "https://open.feishu.cn/open-apis/im/v1/messages/:messageId/resources/:fileKey",
        ({ params, request }) => {
          expect(params.messageId).toBe("om_file_message");
          expect(params.fileKey).toBe(fileKey);
          expect(new URL(request.url).searchParams.get("type")).toBe("file");
          return new HttpResponse(fileBytes, {
            status: 200,
            headers: {
              "content-type": "application/pdf",
              "content-length": String(fileBytes.length),
              "content-disposition":
                'attachment; filename="quarterly-report.pdf"',
            },
          });
        },
      ),
    );
    const app = createAppWithRoutes({
      signal: context.signal,
      routes: zeroIntegrationsFeishuFileRoutes,
    });
    const downloadResponse = await app.request(
      `/api/zero/integrations/feishu/download-file?${new URLSearchParams({
        message_id: "om_misquoted_by_model",
        file_key: fileId ?? "",
        type: "image",
      }).toString()}`,
      {
        headers: {
          authorization: `Bearer ${runsApi.zeroTokenForRunWithCapabilities(
            actor,
            run.id,
            ["feishu:write"],
          )}`,
        },
      },
    );
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get("x-file-name")).toBe(
      "quarterly-report.pdf",
    );
    expect(
      Buffer.from(await downloadResponse.arrayBuffer()).equals(fileBytes),
    ).toBeTruthy();

    const wrongRunResponse = await app.request(
      `/api/zero/integrations/feishu/download-file?${new URLSearchParams({
        message_id: "om_file_message",
        file_key: fileId ?? "",
        type: "file",
      }).toString()}`,
      {
        headers: {
          authorization: `Bearer ${runsApi.zeroTokenForRunWithCapabilities(
            actor,
            randomUUID(),
            ["feishu:write"],
          )}`,
        },
      },
    );
    expect(wrongRunResponse.status).toBe(400);
  });

  it("claims a Feishu message when conversation history loading fails", async () => {
    const fixture = await setupFeishuRunFixture();
    const { actor, runnerGroup, appId, callbackUrl } = fixture;
    await connectFixtureUser(fixture);
    server.use(
      http.get("https://open.feishu.cn/open-apis/im/v1/messages", () => {
        return HttpResponse.json(
          { code: 99_999, msg: "history unavailable" },
          { status: 500 },
        );
      }),
    );

    const prompt = "continue without Feishu history";
    await postEvent(
      callbackUrl,
      directMessage(appId, prompt, "ou_feishu_user"),
      { encrypted: true },
    );
    await flushWaitUntilForTest();

    const run = await findRun(actor, prompt);
    await runsApi.heartbeatRunner(runnerGroup);
    const claim = await runsApi.claimRunnerJob(run.id);
    expect(claim.prompt).toBe(prompt);
    expect(claim.appendSystemPrompt).toContain("Scope: Direct message");
    expect(claim.appendSystemPrompt).not.toContain("# Recent Channel Messages");
    expect(claim.appendSystemPrompt).not.toContain("# Feishu Thread Context");
    await runsApi.requestCancelRun(actor, run.id, [200]);
    await flushWaitUntilForTest();
  });

  it("builds Feishu DM context and canonical response metadata", async () => {
    const fixture = await setupFeishuRunFixture({
      useAlternateInstallationDefault: true,
    });
    const { actor, runnerGroup, appId, callbackUrl, alternateAgentId } =
      fixture;
    await connectFixtureUser(fixture);
    await postEvent(
      callbackUrl,
      directMessage(appId, `/switch ${alternateAgentId}`),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    outboundMessages = [];
    context.mocks.ably.publish.mockClear();
    const historyFileKey = `file_v2_${"b".repeat(200)}`;
    historyMessages = [
      {
        message_id: "om_history_context",
        msg_type: "text",
        create_time: "1",
        sender: {
          id: "ou_previous_user",
          sender_name: "Previous User",
          sender_type: "user",
        },
        body: {
          content: JSON.stringify({
            text: "Earlier Feishu conversation context",
          }),
        },
      },
      {
        message_id: "om_history_file",
        msg_type: "file",
        create_time: "2",
        sender: {
          id: "ou_previous_user",
          sender_name: "Previous User",
          sender_type: "user",
        },
        body: {
          content: JSON.stringify({
            file_key: historyFileKey,
            file_name: "history-report.pdf",
          }),
        },
      },
    ];
    const firstMessageId = `om_${randomUUID()}`;
    await postEvent(
      callbackUrl,
      directMessage(appId, "do the Feishu task", "ou_feishu_user", {
        messageId: firstMessageId,
      }),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    expect(addedReactions).toHaveLength(1);
    expect(context.mocks.ably.publish).not.toHaveBeenCalledWith(
      "feishu:changed",
      null,
    );
    const run = await findRun(actor, "do the Feishu task");
    const pendingParams = requireValue(
      await findPendingChatEventInputParamsByPromptFixture(
        "do the Feishu task",
      ),
      "Expected pending Feishu launch params",
    );
    expect(
      (await readChatEventContextFixture(pendingParams.eventId))
        ?.feishuTenantKey,
    ).toBeNull();
    await useLegacyFeishuTenantKeyFixture(pendingParams.eventId, TENANT_KEY);
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const threadEvents = await accept(
      setupApp({ context })(chatThreadsContract).events({
        headers: { authorization: "Bearer clerk-session" },
        query: {},
      }),
      [200],
    );
    const chatThreadCreated = requireValue(
      threadEvents.body.events.find((event) => {
        return event.kind === "created" && event.agentId === alternateAgentId;
      }),
      "Expected the canonical Feishu chat thread",
    );
    const threadMessages = await accept(
      setupApp({ context })(chatThreadEventsContract).list({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: chatThreadCreated.chatThreadId },
        query: {},
      }),
      [200],
    );
    expect(threadMessages.body.events).toContainEqual(
      expect.objectContaining({
        content: null,
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: "do the Feishu task" },
            {
              type: "source",
              kind: "feishu",
              href: "https://applink.feishu.cn/client/chat/open?openChatId=oc_feishu_dm",
            },
          ],
        },
      }),
    );
    await runsApi.heartbeatRunner(runnerGroup);
    const claim = await runsApi.claimRunnerJob(run.id);
    expect(claim.prompt).toBe("do the Feishu task");
    expect(claim.environment?.ZERO_AGENT_ID).toBe(alternateAgentId);
    expect(claim.appendSystemPrompt).toContain(
      "You are currently running inside: Feishu",
    );
    expect(claim.appendSystemPrompt).toContain("# Current User Info");
    expect(claim.appendSystemPrompt).toContain(
      "Feishu display name: Feishu User",
    );
    expect(claim.appendSystemPrompt).toContain(
      "Feishu open ID: ou_feishu_user",
    );
    expect(claim.appendSystemPrompt).toContain("Scope: Direct message");
    expect(claim.appendSystemPrompt).toContain(`Tenant key: ${TENANT_KEY}`);
    expect(claim.appendSystemPrompt).toContain("Chat ID: oc_feishu_dm");
    expect(claim.appendSystemPrompt).not.toContain("Group ID:");
    expect(claim.appendSystemPrompt).toContain(
      `Installation ID: ${fixture.installationId}`,
    );
    expect(claim.appendSystemPrompt).toContain(
      "Earlier Feishu conversation context",
    );
    expect(claim.appendSystemPrompt).toContain(
      "[Feishu file] history-report.pdf",
    );
    const historyFileId = (claim.appendSystemPrompt ?? "").match(
      / {3}\[FILE_KEY\] (feishu_file_[A-Za-z0-9_-]{22})/u,
    )?.[1];
    expect(historyFileId).toBeTruthy();
    expect(claim.appendSystemPrompt).not.toContain(historyFileKey);
    expect(claim.appendSystemPrompt).toContain("# Feishu Thread Context");
    expect(claim.appendSystemPrompt).toContain(
      "The messages below are from a Feishu conversation",
    );
    expect(claim.appendSystemPrompt).toContain("- RELATIVE_INDEX: -1");
    expect(claim.appendSystemPrompt).toContain(
      "- SENDER: {id: ou_previous_user, name: Previous User}",
    );
    expect(claim.appendSystemPrompt).toContain(
      "zero feishu message send --help",
    );
    expect(claim.appendSystemPrompt).toContain("zero feishu download-file -h");
    expect(claim.appendSystemPrompt).toContain("zero feishu upload-file -h");

    const cliAgentSessionId = `bdd-feishu-cli-${run.id}`;
    await completeRunSession({
      runId: run.id,
      sandboxToken: claim.sandboxToken,
      sessionId: cliAgentSessionId,
      history: `bdd feishu history ${run.id}`,
      assistantText: "Canonical Feishu answer",
    });
    const claimedThreadMessages = await accept(
      setupApp({ context })(chatThreadEventsContract).list({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: chatThreadCreated.chatThreadId },
        query: {},
      }),
      [200],
    );
    const claimedFeishuMessage = claimedThreadMessages.body.events.find(
      (event) => {
        return (
          event.eventType === "input.prompt" &&
          event.revokesEventId !== undefined &&
          event.userMessage.parts.some((part) => {
            return (
              part.type === "source" &&
              part.kind === "feishu" &&
              part.href ===
                "https://applink.feishu.cn/client/chat/open?openChatId=oc_feishu_dm"
            );
          })
        );
      },
    );
    if (!claimedFeishuMessage?.revokesEventId) {
      throw new Error("Expected the claimed Feishu message");
    }
    const claimedFeishuContext = await readChatEventContextFixture(
      claimedFeishuMessage.id,
    );
    const pendingFeishuContext = await readChatEventContextFixture(
      claimedFeishuMessage.revokesEventId,
    );
    expect(claimedFeishuContext).toMatchObject({
      contextType: "feishu",
      contextId: expect.any(String),
      feishuOpenUrl:
        "https://applink.feishu.cn/client/chat/open?openChatId=oc_feishu_dm",
      feishuMessageText: "do the Feishu task",
      feishuMessageFiles: [
        {
          fileId: expect.any(String),
          messageId: "om_history_file",
          fileKey: historyFileKey,
          type: "file",
        },
      ],
      feishuChatType: "p2p",
      feishuTenantKey: TENANT_KEY,
      feishuChatId: "oc_feishu_dm",
      feishuMessageId: firstMessageId,
      feishuThreadId: firstMessageId,
      feishuReplyInThread: false,
      feishuReactionId: expect.any(String),
      feishuSenderOpenId: "ou_feishu_user",
      feishuConnectionId: expect.any(String),
      feishuInstallationId: fixture.installationId,
    });
    expect(claimedFeishuContext?.feishuConversationHistory).toContain(
      "Earlier Feishu conversation context",
    );
    expect(pendingFeishuContext).toMatchObject({
      contextType: "feishu",
      contextId: claimedFeishuContext?.contextId,
      feishuOpenUrl:
        "https://applink.feishu.cn/client/chat/open?openChatId=oc_feishu_dm",
    });
    const completedReply = [...outboundMessages].reverse().find((message) => {
      return (
        message.kind === "send" &&
        messageContent(message).includes("Canonical Feishu answer")
      );
    });
    expect(completedReply?.msgType).toBe("interactive");
    expect(completedReply?.target).toBe("oc_feishu_dm");
    const completedReplyContent = completedReply
      ? messageContent(completedReply)
      : "";
    expect(completedReplyContent).toContain("Audit");
    expect(completedReplyContent).toContain("Claude Sonnet");
    expect(completedReplyContent).toContain(
      "Responded by Feishu default agent",
    );
    expect(removedReactions).toHaveLength(1);

    const client = setupApp({ context })(zeroFeishuConnectContract);
    await accept(
      client.removeInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId: fixture.installationId },
      }),
      [200],
    );
  });

  it("resumes and resets Feishu DM sessions at message and agent boundaries", async () => {
    const fixture = await setupFeishuRunFixture();
    const { actor, runnerGroup, appId, callbackUrl, alternateAgentId } =
      fixture;
    await connectFixtureUser(fixture);
    const firstMessageId = `om_${randomUUID()}`;
    await postEvent(
      callbackUrl,
      directMessage(appId, "start the Feishu DM session", "ou_feishu_user", {
        messageId: firstMessageId,
      }),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const initialRun = await findRun(actor, "start the Feishu DM session");
    await runsApi.heartbeatRunner(runnerGroup);
    const initialClaim = await runsApi.claimRunnerJob(initialRun.id);
    expect(initialClaim.resumeSession).toBeNull();
    const mainSessionId = randomUUID();
    await completeRunSession({
      runId: initialRun.id,
      sandboxToken: initialClaim.sandboxToken,
      sessionId: mainSessionId,
      history: `bdd initial feishu history ${initialRun.id}`,
      assistantText: "Initial Feishu DM answer",
    });

    await postEvent(
      callbackUrl,
      directMessage(appId, "continue the Feishu DM session"),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const followUpRun = await findRun(actor, "continue the Feishu DM session");
    await runsApi.heartbeatRunner(runnerGroup);
    const followUpClaim = await runsApi.claimRunnerJob(followUpRun.id);
    expect(followUpClaim.resumeSession?.sessionId).toBe(mainSessionId);
    await completeRunSession({
      runId: followUpRun.id,
      sandboxToken: followUpClaim.sandboxToken,
      sessionId: mainSessionId,
      history: `bdd continued feishu history ${followUpRun.id}`,
      assistantText: "Continued Feishu DM answer",
    });

    const quotedReplyMessageId = `om_${randomUUID()}`;
    await postEvent(
      callbackUrl,
      directMessage(
        appId,
        "reply without opening a Feishu thread",
        "ou_feishu_user",
        {
          messageId: quotedReplyMessageId,
          rootId: firstMessageId,
        },
      ),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const quotedReplyRun = await findRun(
      actor,
      "reply without opening a Feishu thread",
    );
    await runsApi.heartbeatRunner(runnerGroup);
    const quotedReplyClaim = await runsApi.claimRunnerJob(quotedReplyRun.id);
    expect(quotedReplyClaim.resumeSession?.sessionId).toBe(mainSessionId);
    await completeRunSession({
      runId: quotedReplyRun.id,
      sandboxToken: quotedReplyClaim.sandboxToken,
      sessionId: mainSessionId,
      history: `bdd quoted feishu history ${quotedReplyRun.id}`,
      assistantText: "Feishu quoted reply answer",
    });
    const completedQuotedReply = [...outboundMessages]
      .reverse()
      .find((message) => {
        return (
          message.kind === "send" &&
          messageContent(message).includes("Feishu quoted reply answer")
        );
      });
    expect(completedQuotedReply?.replyInThread).toBeFalsy();

    await postEvent(
      callbackUrl,
      directMessage(appId, `/switch ${alternateAgentId}`),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    await postEvent(
      callbackUrl,
      directMessage(appId, "use the switched Feishu agent"),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const switchedAgentRun = await findRun(
      actor,
      "use the switched Feishu agent",
    );
    await runsApi.heartbeatRunner(runnerGroup);
    const switchedAgentClaim = await runsApi.claimRunnerJob(
      switchedAgentRun.id,
    );
    expect(switchedAgentClaim.environment?.ZERO_AGENT_ID).toBe(
      alternateAgentId,
    );
    expect(switchedAgentClaim.resumeSession).toBeNull();
    await runsApi.requestCancelRun(actor, switchedAgentRun.id, [200]);
    await flushWaitUntilForTest();

    const client = setupApp({ context })(zeroFeishuConnectContract);
    await accept(
      client.removeInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId: fixture.installationId },
      }),
      [200],
    );
  });

  it("forks Feishu DM threads without replacing the main session", async () => {
    const fixture = await setupFeishuRunFixture();
    const { actor, runnerGroup, appId, callbackUrl } = fixture;
    await connectFixtureUser(fixture);
    const mainMessageId = `om_${randomUUID()}`;
    await postEvent(
      callbackUrl,
      directMessage(appId, "start the main Feishu DM", "ou_feishu_user", {
        messageId: mainMessageId,
      }),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const initialRun = await findRun(actor, "start the main Feishu DM");
    await runsApi.heartbeatRunner(runnerGroup);
    const initialClaim = await runsApi.claimRunnerJob(initialRun.id);
    expect(initialClaim.resumeSession).toBeNull();
    const mainSessionId = randomUUID();
    await completeRunSession({
      runId: initialRun.id,
      sandboxToken: initialClaim.sandboxToken,
      sessionId: mainSessionId,
      history: `bdd main feishu history ${initialRun.id}`,
      assistantText: "Initial main Feishu answer",
    });

    const feishuThreadId = `omt_${randomUUID()}`;
    const threadMessageId = `om_${randomUUID()}`;
    await postEvent(
      callbackUrl,
      directMessage(appId, "open a new Feishu thread", "ou_feishu_user", {
        messageId: threadMessageId,
        rootId: mainMessageId,
        threadId: feishuThreadId,
      }),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const threadRun = await findRun(actor, "open a new Feishu thread");
    await runsApi.heartbeatRunner(runnerGroup);
    const threadClaim = await runsApi.claimRunnerJob(threadRun.id);
    expect(threadClaim.resumeSession).toBeNull();
    const threadSessionId = randomUUID();
    await completeRunSession({
      runId: threadRun.id,
      sandboxToken: threadClaim.sandboxToken,
      sessionId: threadSessionId,
      history: `bdd feishu thread history ${threadRun.id}`,
      assistantText: "Feishu thread answer",
    });
    const completedThreadReply = [...outboundMessages]
      .reverse()
      .find((message) => {
        return (
          message.kind === "reply" &&
          message.target === threadMessageId &&
          messageContent(message).includes("Feishu thread answer")
        );
      });
    expect(completedThreadReply?.replyInThread).toBeTruthy();

    const threadHelpMessageId = `om_${randomUUID()}`;
    await postEvent(
      callbackUrl,
      directMessage(appId, "/help", "ou_feishu_user", {
        messageId: threadHelpMessageId,
        rootId: mainMessageId,
        threadId: feishuThreadId,
      }),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const threadHelpReply = [...outboundMessages].reverse().find((message) => {
      return (
        message.kind === "reply" &&
        message.target === threadHelpMessageId &&
        messageContent(message).includes("Zero commands")
      );
    });
    expect(threadHelpReply?.replyInThread).toBeTruthy();

    await postEvent(
      callbackUrl,
      directMessage(
        appId,
        "continue in the original Feishu thread",
        "ou_feishu_user",
        {
          threadId: feishuThreadId,
        },
      ),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const threadFollowUpRun = await findRun(
      actor,
      "continue in the original Feishu thread",
    );
    await runsApi.heartbeatRunner(runnerGroup);
    const threadFollowUpClaim = await runsApi.claimRunnerJob(
      threadFollowUpRun.id,
    );
    expect(threadFollowUpClaim.resumeSession?.sessionId).toBe(threadSessionId);
    await runsApi.requestCancelRun(actor, threadFollowUpRun.id, [200]);
    await flushWaitUntilForTest();

    await postEvent(
      callbackUrl,
      directMessage(appId, "return to the main Feishu DM"),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const mainDmRun = await findRun(actor, "return to the main Feishu DM");
    await runsApi.heartbeatRunner(runnerGroup);
    const mainDmClaim = await runsApi.claimRunnerJob(mainDmRun.id);
    expect(mainDmClaim.resumeSession?.sessionId).toBe(mainSessionId);
    await runsApi.requestCancelRun(actor, mainDmRun.id, [200]);
    await flushWaitUntilForTest();

    const client = setupApp({ context })(zeroFeishuConnectContract);
    await accept(
      client.removeInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId: fixture.installationId },
      }),
      [200],
    );
  });

  it("shows the run queue link when Feishu reaches the concurrency limit", async () => {
    const fixture = await setupFeishuRunFixture();
    const { actor, appId, callbackUrl } = fixture;
    await connectFixtureUser(fixture);
    const prompts = [
      "first concurrent Feishu task",
      "second concurrent Feishu task",
      "queued Feishu task",
    ] as const;
    const queuedMessageId = `om_${randomUUID()}`;
    for (const [index, prompt] of prompts.entries()) {
      await postEvent(
        callbackUrl,
        directMessage(appId, prompt, "ou_feishu_user", {
          chatId: `oc_feishu_concurrent_${index}`,
          ...(index === 2
            ? {
                messageId: queuedMessageId,
                rootId: `om_${randomUUID()}`,
                threadId: `omt_${randomUUID()}`,
              }
            : {}),
        }),
        {
          encrypted: true,
        },
      );
      await flushWaitUntilForTest();
    }

    const queueNotice = outboundMessages.find((message) => {
      return messageContent(message).includes("Run queued");
    });
    expect(queueNotice).toMatchObject({
      kind: "reply",
      target: queuedMessageId,
      replyInThread: true,
    });
    expect(queueNotice?.msgType).toBe("interactive");
    const queueNoticeContent = queueNotice ? messageContent(queueNotice) : "";
    expect(queueNoticeContent).toContain("Concurrency limit reached");
    expect(queueNoticeContent).toContain("Will start automatically");
    expect(queueNoticeContent).toContain(
      `[View queue](${APP_ORIGIN}/?queue=1)`,
    );

    const runs = await Promise.all(
      prompts.map(async (prompt) => {
        return await findRun(actor, prompt);
      }),
    );
    expect(runs[2]?.status).toBe("queued");
    for (const run of [...runs].reverse()) {
      await runsApi.requestCancelRun(actor, run.id, [200]);
    }
    await flushWaitUntilForTest();
    const client = setupApp({ context })(zeroFeishuConnectContract);
    await accept(
      client.removeInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId: fixture.installationId },
      }),
      [200],
    );
  });

  it("keeps Feishu group control cases out of runs and resumes queued tasks through the canonical session", async () => {
    const fixture = await setupFeishuRunFixture();
    const { actor, runnerGroup, appId, callbackUrl, defaultAgentId } = fixture;
    const secondOpenId = "ou_feishu_canonical_group_user";
    const secondActor = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: actor.orgId,
      orgRole: "org:member",
    });
    await enableFeishuIntegration(secondActor, {
      [FeatureSwitchKey.ZeroDebug]: true,
    });

    await postEvent(
      callbackUrl,
      groupMessage(appId, "unconnected group task", {
        openId: secondOpenId,
      }),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    expect(
      outboundMessages.some((message) => {
        return (
          message.kind === "reply" &&
          messageContent(message).includes("Connect your account")
        );
      }),
    ).toBeTruthy();
    expect(
      (await runsApi.listAgentRuns(secondActor, { limit: 20 })).runs.some(
        (run) => {
          return run.prompt === "unconnected group task";
        },
      ),
    ).toBeFalsy();
    await connectFixtureUser(fixture, secondActor, secondOpenId);
    await postEvent(
      callbackUrl,
      groupMessage(appId, "/help", { openId: secondOpenId }),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    expect(
      outboundMessages.some((message) => {
        return messageContent(message).includes("Zero commands");
      }),
    ).toBeTruthy();

    await authOrgApi.updateAgentMetadata(actor, defaultAgentId, {
      visibility: "private",
    });
    await postEvent(
      callbackUrl,
      groupMessage(appId, "unavailable group task", {
        openId: secondOpenId,
      }),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    expect(
      outboundMessages.some((message) => {
        return messageContent(message).includes("Agent unavailable");
      }),
    ).toBeTruthy();
    const controlRuns = await runsApi.listAgentRuns(secondActor, { limit: 20 });
    expect(
      controlRuns.runs.some((run) => {
        return [
          "unconnected group task",
          "/help",
          "unavailable group task",
        ].includes(run.prompt);
      }),
    ).toBeFalsy();

    await authOrgApi.updateAgentMetadata(actor, defaultAgentId, {
      visibility: "public",
    });
    outboundMessages = [];
    const firstMessageId = `om_${randomUUID()}`;
    const firstPrompt = "first canonical group task";
    const secondPrompt = "second queued canonical group task";
    await postEvent(
      callbackUrl,
      groupMessage(appId, firstPrompt, {
        messageId: firstMessageId,
        openId: secondOpenId,
      }),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const firstRun = await findRun(secondActor, firstPrompt);

    await postEvent(
      callbackUrl,
      groupMessage(appId, secondPrompt, {
        rootId: firstMessageId,
        threadId: `omt_${randomUUID()}`,
        openId: secondOpenId,
      }),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    expect(
      (await runsApi.listAgentRuns(secondActor, { limit: 20 })).runs.some(
        (run) => {
          return run.prompt === secondPrompt;
        },
      ),
    ).toBeFalsy();
    const queuedFeishuParams =
      await findPendingChatEventInputParamsByPromptFixture(secondPrompt);
    expect(queuedFeishuParams).toMatchObject({
      eventId: expect.any(String),
      encryptedParams: expect.any(String),
    });
    if (!queuedFeishuParams) {
      throw new Error("Expected queued canonical Feishu transport params");
    }
    const secondOrgId = requireValue(
      secondActor.orgId,
      "Expected the second Feishu actor organization",
    );
    await expect(
      decryptChatEventInputParamsFixture(queuedFeishuParams.eventId, {
        orgId: secondOrgId,
        userId: secondActor.userId,
      }),
    ).resolves.toStrictEqual({ version: 1 });
    await runsApi.heartbeatRunner(runnerGroup);
    const firstClaim = await runsApi.claimRunnerJob(firstRun.id);
    const firstCliSessionId = `bdd-feishu-canonical-group-${firstRun.id}`;
    await completeRunSession({
      runId: firstRun.id,
      sandboxToken: firstClaim.sandboxToken,
      sessionId: firstCliSessionId,
      history: `bdd feishu canonical group history ${firstRun.id}`,
      assistantText: "First canonical group answer",
    });

    const secondRun = await findRun(secondActor, secondPrompt);
    await expect(
      readChatEventInputParamsFixture(queuedFeishuParams.eventId),
    ).resolves.toBeNull();
    await runsApi.heartbeatRunner(runnerGroup);
    const secondClaim = await runsApi.claimRunnerJob(secondRun.id);
    expect(secondClaim.prompt).toBe(secondPrompt);
    expect(secondClaim.appendSystemPrompt).toContain("Scope: Group mention");
    expect(secondClaim.resumeSession?.sessionId).toBe(firstCliSessionId);
    await runsApi.requestCancelRun(secondActor, secondRun.id, [200]);
    await flushWaitUntilForTest();

    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const client = setupApp({ context })(zeroFeishuConnectContract);
    await accept(
      client.removeInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId: fixture.installationId },
      }),
      [200],
    );
  });

  it("runs mentioned group tasks with thread history, dedupe, and session resume", async () => {
    const fixture = await setupFeishuRunFixture();
    const { actor, runnerGroup, appId, callbackUrl } = fixture;
    await connectFixtureUser(fixture);
    await postEvent(
      callbackUrl,
      groupMessage(appId, "ignore this group message", {
        mentionBot: false,
      }),
      { encrypted: true },
    );
    await postEvent(
      callbackUrl,
      groupMessage(appId, "ignore a mention for another bot", {
        mentionOpenId: "ou_another_bot",
      }),
      { encrypted: true },
    );
    await postEvent(
      callbackUrl,
      groupMessage(appId, "ignore an app-authored message", {
        senderType: "app",
      }),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const afterUnmentioned = await runsApi.listAgentRuns(actor, { limit: 20 });
    expect(
      afterUnmentioned.runs.some((candidate) => {
        return candidate.prompt.startsWith("ignore ");
      }),
    ).toBeFalsy();

    const groupThreadId = `omt_${randomUUID()}`;
    const groupMessageId = `om_${randomUUID()}`;
    historyMessages = [
      {
        message_id: "om_group_recent",
        msg_type: "text",
        create_time: "1",
        sender: {
          id: "ou_recent_user",
          sender_name: "Recent User",
          sender_type: "user",
        },
        body: {
          content: JSON.stringify({ text: "Recent group context" }),
        },
      },
      {
        message_id: "om_group_thread",
        root_id: groupMessageId,
        msg_type: "text",
        create_time: "2",
        sender: {
          id: "ou_thread_user",
          sender_name: "Thread User",
          sender_type: "user",
        },
        body: {
          content: JSON.stringify({ text: "Current thread context" }),
        },
      },
    ];
    const mentioned = groupMessage(appId, "handle this group task", {
      messageId: groupMessageId,
    });
    await postEvent(callbackUrl, mentioned, { encrypted: true });
    await postEvent(callbackUrl, mentioned, { encrypted: true });
    await flushWaitUntilForTest();
    const groupRuns = await runsApi.listAgentRuns(actor, { limit: 20 });
    const matchingGroupRuns = groupRuns.runs.filter((candidate) => {
      return candidate.prompt === "handle this group task";
    });
    expect(matchingGroupRuns).toHaveLength(1);
    const groupRun = requireValue(
      matchingGroupRuns[0],
      "Expected a group mention to create an agent run",
    );
    await runsApi.heartbeatRunner(runnerGroup);
    const groupClaim = await runsApi.claimRunnerJob(groupRun.id);
    expect(groupClaim.prompt).toBe("handle this group task");
    expect(groupClaim.appendSystemPrompt).toContain("Scope: Group mention");
    expect(groupClaim.appendSystemPrompt).toContain(
      `Tenant key: ${TENANT_KEY}`,
    );
    expect(groupClaim.appendSystemPrompt).toContain("Chat ID: oc_feishu_group");
    expect(groupClaim.appendSystemPrompt).toContain(
      "Group ID: oc_feishu_group (same as Chat ID; use it directly as the `--chat` value for `zero feishu message send`)",
    );
    expect(groupClaim.appendSystemPrompt).toContain(
      "# Recent Channel Messages",
    );
    expect(groupClaim.appendSystemPrompt).toContain("# Feishu Thread Context");
    expect(groupClaim.appendSystemPrompt).toContain(
      "- SENDER: {id: ou_recent_user, name: Recent User}",
    );
    expect(groupClaim.appendSystemPrompt).toContain(
      "- SENDER: {id: ou_thread_user, name: Thread User}",
    );
    expect(groupClaim.appendSystemPrompt).toContain("Recent group context");
    expect(groupClaim.appendSystemPrompt).toContain("Current thread context");
    expect(groupClaim.appendSystemPrompt).toContain(
      `Thread ID: ${groupMessageId}`,
    );
    const groupCliSessionId = `bdd-feishu-group-cli-${groupRun.id}`;
    await completeRunSession({
      runId: groupRun.id,
      sandboxToken: groupClaim.sandboxToken,
      sessionId: groupCliSessionId,
      history: `bdd feishu group history ${groupRun.id}`,
      assistantText: "Canonical Feishu group answer",
    });
    const groupReply = [...outboundMessages].reverse().find((message) => {
      return message.kind === "reply" && message.target === groupMessageId;
    });
    expect(groupReply?.replyInThread).toBeTruthy();
    expect(groupReply ? messageContent(groupReply) : "").not.toContain(
      "Reply to",
    );

    const secondOpenId = "ou_feishu_second_user";
    const secondActor = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: actor.orgId,
      orgRole: "org:member",
    });
    await enableFeishuIntegration(secondActor, {
      [FeatureSwitchKey.ZeroDebug]: true,
    });
    await connectFixtureUser(fixture, secondActor, secondOpenId);
    await postEvent(
      callbackUrl,
      groupMessage(appId, "handle this group task as another user", {
        rootId: groupMessageId,
        threadId: groupThreadId,
        openId: secondOpenId,
      }),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const secondGroupRun = await findRun(
      secondActor,
      "handle this group task as another user",
    );
    await runsApi.heartbeatRunner(runnerGroup);
    const secondGroupClaim = await runsApi.claimRunnerJob(secondGroupRun.id);
    await completeRunSession({
      runId: secondGroupRun.id,
      sandboxToken: secondGroupClaim.sandboxToken,
      sessionId: `bdd-feishu-second-group-cli-${secondGroupRun.id}`,
      history: `bdd feishu second group history ${secondGroupRun.id}`,
      assistantText: "Canonical Feishu second group answer",
    });
    const secondGroupReply = [...outboundMessages].reverse().find((message) => {
      return (
        message.kind === "reply" &&
        messageContent(message).includes("Canonical Feishu second group answer")
      );
    });
    expect(secondGroupReply ? messageContent(secondGroupReply) : "").toContain(
      `Reply to <at id=${secondOpenId}></at>`,
    );

    await postEvent(
      callbackUrl,
      groupMessage(appId, "continue this group task", {
        rootId: groupMessageId,
        threadId: groupThreadId,
      }),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const groupFollowUp = await findRun(actor, "continue this group task");
    await runsApi.heartbeatRunner(runnerGroup);
    const groupFollowUpClaim = await runsApi.claimRunnerJob(groupFollowUp.id);
    expect(groupFollowUpClaim.resumeSession?.sessionId).toBe(groupCliSessionId);
    await runsApi.requestCancelRun(actor, groupFollowUp.id, [200]);
    await flushWaitUntilForTest();
    const client = setupApp({ context })(zeroFeishuConnectContract);
    await accept(
      client.removeInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId: fixture.installationId },
      }),
      [200],
    );
  });
});
