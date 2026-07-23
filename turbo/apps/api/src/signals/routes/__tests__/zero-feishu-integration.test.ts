import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { Buffer } from "node:buffer";

import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { zeroFeishuConnectContract } from "@vm0/api-contracts/contracts/zero-feishu-connect";
import { zeroFeishuOauthContract } from "@vm0/api-contracts/contracts/zero-feishu-oauth";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createAppWithRoutes } from "../../../app-factory-core";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { now } from "../../external/time";
import { zeroFeishuBrowserConnectRoutes } from "../zero-feishu-browser-connect";
import { zeroFeishuEventsRoutes } from "../zero-feishu-events";
import { zeroFeishuOauthRoutes } from "../zero-feishu-oauth";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const authOrgApi = createAuthOrgAgentsBddApi(context);
const runsApi = createRunsApi(context);
const webhooksApi = createWebhookCallbackApi(context);
const APP_ORIGIN = "https://app.vm0.test";
const ENCRYPT_KEY = "feishu-test-encrypt-key";
const VERIFICATION_TOKEN = "feishu-test-verification-token";
const APP_SECRET = "feishu-test-secret";
const TENANT_KEY = "tenant_feishu_integration_test";

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

function directMessage(appId: string, text: string): unknown {
  return v2Event(appId, "im.message.receive_v1", {
    sender: {
      sender_id: { open_id: "ou_feishu_user" },
      sender_type: "user",
    },
    message: {
      message_id: `om_${randomUUID()}`,
      chat_id: "oc_feishu_dm",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text }),
    },
  });
}

async function enableFeishuIntegration(actor: {
  readonly userId: string;
  readonly orgId: string | null;
}): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Feishu integration tests require an organization");
  }
  await updateFeatureSwitchesForUser(
    context,
    { userId: actor.userId, orgId: actor.orgId },
    {
      [FeatureSwitchKey.FeishuIntegration]: true,
    },
  );
}

beforeEach(() => {
  mockEnv("APP_URL", APP_ORIGIN);
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
          app_name: "Okou Feishu",
          avatar_url: "https://example.com/okou-feishu.png",
        },
      });
    }),
    http.post("https://open.feishu.cn/open-apis/authen/v2/oauth/token", () => {
      return HttpResponse.json({
        code: 0,
        access_token: "feishu-user-access-token",
      });
    }),
    http.get("https://open.feishu.cn/open-apis/authen/v1/user_info", () => {
      return HttpResponse.json({
        code: 0,
        data: {
          name: "Feishu User",
          open_id: "ou_oauth_user",
          tenant_key: TENANT_KEY,
        },
      });
    }),
  );
});

describe("Feishu integration", () => {
  let replyTexts: string[];

  beforeEach(() => {
    replyTexts = [];
    server.use(
      http.post(
        "https://open.feishu.cn/open-apis/im/v1/messages/:messageId/reply",
        async ({ request }) => {
          const body = (await request.json()) as {
            readonly content: string;
          };
          const content = JSON.parse(body.content) as {
            readonly text: string;
          };
          replyTexts.push(content.text);
          return HttpResponse.json({ code: 0, msg: "success" });
        },
      ),
    );
  });

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

  it("keeps multiple Feishu apps installed in the same organization", async () => {
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
      displayName: "Feishu multi-bot agent",
      visibility: "public",
    });
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    const client = setupApp({ context })(zeroFeishuConnectContract);

    for (const appId of [firstAppId, secondAppId]) {
      await accept(
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
    }
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
      [409],
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
    expect(status.body.installations).toHaveLength(2);
    expect(
      status.body.installations?.map((installation) => {
        return installation.appId;
      }),
    ).toStrictEqual([firstAppId, secondAppId]);

    for (const installation of status.body.installations ?? []) {
      await accept(
        client.removeInstallation({
          headers: { authorization: "Bearer clerk-session" },
          params: { installationId: installation.id },
        }),
        [200],
      );
    }
  });

  it("allows bot owners and organization admins to manage installations", async () => {
    const actor = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      orgRole: "org:member",
    });
    authOrgApi.acceptAgentStorageWrites();
    await enableFeishuIntegration(actor);
    const agent = await authOrgApi.createAgent(actor, {
      displayName: "Feishu managed bot agent",
      visibility: "public",
    });
    mocks.clerk.session(actor.userId, actor.orgId, "org:member");
    const client = setupApp({ context })(zeroFeishuConnectContract);

    for (const appId of [`cli_${randomUUID()}`, `cli_${randomUUID()}`]) {
      await accept(
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
    }

    const ownerStatus = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(
      ownerStatus.body.installations?.every((installation) => {
        return installation.canManage;
      }),
    ).toBeTruthy();
    const [ownerManagedInstallation, adminManagedInstallation] =
      ownerStatus.body.installations ?? [];
    if (!ownerManagedInstallation || !adminManagedInstallation) {
      throw new Error("Expected two Feishu installations");
    }
    const completed = await accept(
      client.updateInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId: ownerManagedInstallation.id },
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
        params: { installationId: ownerManagedInstallation.id },
      }),
      [200],
    );

    const member = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: actor.orgId,
      orgRole: "org:member",
    });
    await enableFeishuIntegration(member);
    mocks.clerk.session(member.userId, member.orgId, "org:member");
    const memberStatus = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(memberStatus.body.installations?.[0]?.canManage).toBeFalsy();
    await accept(
      client.setup({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          appId: adminManagedInstallation.appId,
          appSecret: APP_SECRET,
          verificationToken: VERIFICATION_TOKEN,
          defaultAgentId: agent.agentId,
          installationId: adminManagedInstallation.id,
        },
      }),
      [403],
    );
    await accept(
      client.removeInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId: adminManagedInstallation.id },
      }),
      [403],
    );

    const admin = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: actor.orgId,
      orgRole: "org:admin",
    });
    await enableFeishuIntegration(admin);
    mocks.clerk.session(admin.userId, admin.orgId, "org:admin");
    await accept(
      client.removeInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId: adminManagedInstallation.id },
      }),
      [200],
    );
  });

  it("connects the current Feishu user through OAuth", async () => {
    const appId = `cli_${randomUUID()}`;
    const actor = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      orgRole: "org:member",
    });
    authOrgApi.acceptAgentStorageWrites();
    await enableFeishuIntegration(actor);
    const agent = await authOrgApi.createAgent(actor, {
      displayName: "Feishu OAuth agent",
      visibility: "public",
    });
    mocks.clerk.session(actor.userId, actor.orgId, "org:member");
    mockClerkMembership(context, actor, "org:member");
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

    const status = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const connectUrl = status.body.installations?.[0]?.connectUrl;
    expect(connectUrl).toBeDefined();
    expect(status.body.oauthRedirectUrl).toBe(
      "https://www.vm0.test/api/zero/feishu/oauth/callback",
    );
    if (!connectUrl) {
      throw new Error("Expected Feishu status to return an OAuth connect URL");
    }

    const oauthApp = createAppWithRoutes({
      signal: context.signal,
      routes: zeroFeishuOauthRoutes,
    });
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const unauthenticatedResponse = await oauthApp.request(connectUrl);
    expect(unauthenticatedResponse.status).toBe(307);
    const signInUrl = new URL(
      unauthenticatedResponse.headers.get("location") ?? "",
    );
    expect(signInUrl.origin).toBe(APP_ORIGIN);
    expect(signInUrl.pathname).toBe("/sign-in");
    expect(signInUrl.searchParams.get("redirect_url")).toBe(connectUrl);

    const otherActor = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: actor.orgId,
      orgRole: "org:member",
    });
    mocks.clerk.session(otherActor.userId, otherActor.orgId, "org:member");
    mockClerkMembership(context, otherActor, "org:member");
    const mismatchedUserResponse = await oauthApp.request(connectUrl, {
      headers: { cookie: "__session=opaque" },
    });
    expect(mismatchedUserResponse.status).toBe(400);

    mocks.clerk.session(actor.userId, actor.orgId, "org:member");
    mockClerkMembership(context, actor, "org:member");
    const connectResponse = await oauthApp.request(connectUrl, {
      headers: { cookie: "__session=opaque" },
    });
    expect(connectResponse.status).toBe(307);
    const authorizationUrl = new URL(
      connectResponse.headers.get("location") ?? "",
    );
    expect(authorizationUrl.origin).toBe("https://accounts.feishu.cn");
    expect(authorizationUrl.searchParams.get("client_id")).toBe(appId);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://www.vm0.test/api/zero/feishu/oauth/callback",
    );
    const state = authorizationUrl.searchParams.get("state");
    if (!state) {
      throw new Error("Expected Feishu authorization URL to include state");
    }

    const callbackResponse = await oauthApp.request(
      `${zeroFeishuOauthContract.callback.path}?${new URLSearchParams({
        code: "feishu-oauth-code",
        state,
      })}`,
      { headers: { cookie: "__session=opaque" } },
    );
    expect(callbackResponse.status).toBe(307);
    expect(callbackResponse.headers.get("location")).toBe(
      `https://applink.feishu.cn/client/bot/open?appId=${appId}`,
    );

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

    await accept(
      client.removeInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId },
      }),
      [200],
    );
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

  it("connects a Feishu DM user, runs the default agent, and resumes the DM session", async () => {
    const appId = `cli_${randomUUID()}`;
    const actor = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      orgRole: "org:admin",
    });
    const runnerGroup = runsApi.configureRunnerGroup();
    await enableFeishuIntegration(actor);
    authOrgApi.acceptAgentStorageWrites();
    runsApi.acceptStorageDownloads();
    runsApi.acceptTelemetryIngest();
    const agent = await authOrgApi.createAgent(actor, {
      displayName: "Feishu default agent",
      visibility: "public",
    });
    await authOrgApi.setDefaultAgent(actor, agent.agentId);
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

    const firstMessage = await postEvent(
      callbackUrl,
      directMessage(appId, "hello"),
      { encrypted: true },
    );
    expect(firstMessage.status).toBe(200);
    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "feishu:changed",
      null,
    );
    expect(replyTexts).toHaveLength(1);
    const firstReply = replyTexts[0];
    expect(firstReply).toContain("Please connect your VM0 account first");
    const connectUrl = firstReply?.match(/https:\/\/\S+/u)?.[0];
    expect(connectUrl).toBeDefined();
    if (!connectUrl) {
      throw new Error("Expected Feishu to send a connect URL");
    }
    expect(new URL(connectUrl).origin).toBe("https://www.vm0.test");

    const connectApp = createAppWithRoutes({
      signal: context.signal,
      routes: zeroFeishuBrowserConnectRoutes,
    });
    const connectResponse = await connectApp.request(connectUrl, {
      headers: { cookie: "__session=opaque" },
    });
    expect(connectResponse.status).toBe(307);
    expect(connectResponse.headers.get("location")).toBe(
      `${APP_ORIGIN}/works?feishu=connected`,
    );

    const otherActor = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: actor.orgId,
      orgRole: "org:member",
    });
    mocks.clerk.session(otherActor.userId, otherActor.orgId, "org:member");
    const rebindResponse = await connectApp.request(connectUrl, {
      headers: { cookie: "__session=opaque" },
    });
    expect(rebindResponse.status).toBe(307);
    expect(rebindResponse.headers.get("location")).toBe(
      `${APP_ORIGIN}/works?feishuError=This+Feishu+account+is+already+connected`,
    );
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");

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
      defaultAgentId: agent.agentId,
    });

    context.mocks.ably.publish.mockClear();
    await postEvent(callbackUrl, directMessage(appId, "do the Feishu task"), {
      encrypted: true,
    });
    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish).not.toHaveBeenCalledWith(
      "feishu:changed",
      null,
    );
    const listed = await runsApi.listAgentRuns(actor, { limit: 20 });
    const run = listed.runs.find((candidate) => {
      return candidate.prompt === "do the Feishu task";
    });
    expect(run).toBeDefined();
    if (!run) {
      throw new Error("Expected Feishu DM to create an agent run");
    }

    await runsApi.heartbeatRunner(runnerGroup);
    const claim = await runsApi.claimRunnerJob(run.id);
    expect(claim.appendSystemPrompt).toContain(
      "You are currently running inside: Feishu",
    );
    expect(claim.appendSystemPrompt).toContain("Scope: Direct message");

    const cliAgentSessionId = `bdd-feishu-cli-${run.id}`;
    const history = `bdd feishu history ${run.id}`;
    const historyHash = createHash("sha256").update(history).digest("hex");
    const historySize = Buffer.byteLength(history, "utf8");
    const sandboxHeaders = {
      authorization: `Bearer ${claim.sandboxToken}`,
    };
    await webhooksApi.requestAgentCheckpointPrepareHistory(
      {
        runId: run.id,
        hash: historyHash,
        rawSize: historySize,
        encodedSize: historySize,
        encoding: "identity",
      },
      sandboxHeaders,
      [200],
    );
    await webhooksApi.requestAgentCheckpoint(
      {
        runId: run.id,
        cliAgentType: "claude-code",
        cliAgentSessionId,
        cliAgentSessionHistoryHash: historyHash,
      },
      sandboxHeaders,
      [200],
    );
    await webhooksApi.requestAgentComplete(
      { runId: run.id, exitCode: 0 },
      sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();
    expect(replyTexts.at(-1)).toBe("Task completed successfully.");

    await postEvent(
      callbackUrl,
      directMessage(appId, "continue the Feishu task"),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const followUpList = await runsApi.listAgentRuns(actor, { limit: 20 });
    const followUp = followUpList.runs.find((candidate) => {
      return candidate.prompt === "continue the Feishu task";
    });
    expect(followUp).toBeDefined();
    if (!followUp) {
      throw new Error("Expected a follow-up Feishu DM to create an agent run");
    }
    await runsApi.heartbeatRunner(runnerGroup);
    const followUpClaim = await runsApi.claimRunnerJob(followUp.id);
    expect(followUpClaim.resumeSession?.sessionId).toBe(cliAgentSessionId);
    await runsApi.requestCancelRun(actor, followUp.id, [200]);

    const disconnected = await accept(
      client.disconnect({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(disconnected.body).toStrictEqual({ success: true });
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
      client.remove({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
  });
});
