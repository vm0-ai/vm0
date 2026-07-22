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

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createAppWithRoutes } from "../../../app-factory-core";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { now } from "../../external/time";
import { zeroFeishuBrowserConnectRoutes } from "../zero-feishu-browser-connect";
import { zeroFeishuEventsRoutes } from "../zero-feishu-events";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
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
    readonly validSignature?: boolean;
    readonly timestamp?: number;
  } = {},
): Promise<Response> {
  const body = options.encrypted
    ? encryptPayload(payload)
    : JSON.stringify(payload);
  const headers = new Headers(
    signedHeaders(body, options.timestamp ?? Math.floor(now() / 1000)),
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

beforeEach(() => {
  mockEnv("APP_URL", APP_ORIGIN);
  mockEnv("VM0_WEB_URL", "https://www.vm0.test");
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

  it("verifies and decrypts URL verification callbacks", async () => {
    const appId = `cli_${randomUUID()}`;
    const actor = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      orgRole: "org:admin",
    });
    authOrgApi.acceptAgentStorageWrites();
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

    const response = await postEvent(callbackUrl, payload, { encrypted: true });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      challenge: "challenge-value",
    });

    const rejected = await postEvent(callbackUrl, payload, {
      encrypted: true,
      validSignature: false,
    });
    expect(rejected.status).toBe(401);

    const stale = await postEvent(callbackUrl, payload, {
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

    const firstMessage = await postEvent(
      callbackUrl,
      directMessage(appId, "hello"),
      { encrypted: true },
    );
    expect(firstMessage.status).toBe(200);
    await flushWaitUntilForTest();
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

    await postEvent(callbackUrl, directMessage(appId, "do the Feishu task"), {
      encrypted: true,
    });
    await flushWaitUntilForTest();
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
