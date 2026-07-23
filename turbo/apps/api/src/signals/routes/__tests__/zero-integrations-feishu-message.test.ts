import { randomUUID } from "node:crypto";

import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { integrationsFeishuMessageContract } from "@vm0/api-contracts/contracts/integrations";
import { zeroFeishuConnectContract } from "@vm0/api-contracts/contracts/zero-feishu-connect";
import { zeroFeishuOauthContract } from "@vm0/api-contracts/contracts/zero-feishu-oauth";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { now } from "../../external/time";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import type { ApiTestUser } from "./helpers/api-bdd";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const authOrgApi = createAuthOrgAgentsBddApi(context);

interface CapturedRequest {
  readonly kind: "reply" | "send";
  readonly receiveIdType: string | null;
  readonly target: string;
  readonly msgType: string;
  readonly content: Readonly<Record<string, unknown>>;
  readonly replyInThread: boolean;
}

interface FeishuRequestBody {
  readonly receive_id?: string;
  readonly msg_type: string;
  readonly content: string;
  readonly reply_in_thread?: boolean;
}

function zeroToken(args: {
  readonly userId: string;
  readonly orgId: string;
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: `run_${randomUUID()}`,
    capabilities: ["feishu:write"],
    iat: seconds,
    exp: seconds + 60,
  });
}

function sandboxToken(args: {
  readonly userId: string;
  readonly orgId: string;
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "sandbox",
    userId: args.userId,
    orgId: args.orgId,
    runId: `run_${randomUUID()}`,
    iat: seconds,
    exp: seconds + 60,
  });
}

interface FeishuTestActor extends ApiTestUser {
  readonly orgId: string;
  readonly orgRole: "org:admin";
}

async function setupFeishuInstallation(
  actorOverride?: FeishuTestActor,
): Promise<{
  readonly actor: FeishuTestActor;
  readonly installationId: string;
}> {
  const userId = `user_${randomUUID()}`;
  const actor: FeishuTestActor = actorOverride ?? {
    userId,
    orgId: `org_${randomUUID()}`,
    orgRole: "org:admin",
    email: `${userId}@example.test`,
  };
  await updateFeatureSwitchesForUser(context, actor, {
    [FeatureSwitchKey.FeishuIntegration]: true,
  });
  authOrgApi.acceptAgentStorageWrites();
  const agent = await authOrgApi.createAgent(actor, {
    displayName: "Feishu CLI agent",
    visibility: "public",
  });
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  const client = setupApp({ context })(zeroFeishuConnectContract);
  const setup = await accept(
    client.setup({
      headers: { authorization: "Bearer clerk-session" },
      body: {
        appId: `cli_${randomUUID()}`,
        appSecret: "feishu-cli-secret",
        verificationToken: `verification_${randomUUID()}`,
        defaultAgentId: agent.agentId,
        createNew: true,
      },
    }),
    [200],
  );
  const installationId = setup.body.installationId;
  if (!installationId) {
    throw new Error("Expected Feishu installation ID");
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
  mockClerkMembership(context, actor, "org:admin");
  return { actor, installationId };
}

function requireTestValue<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}

async function connectCurrentFeishuUser(actor: FeishuTestActor): Promise<void> {
  const statusClient = setupApp({ context })(zeroFeishuConnectContract);
  const status = await accept(
    statusClient.getStatus({
      headers: { authorization: "Bearer clerk-session" },
    }),
    [200],
  );
  const connectUrl = requireTestValue(
    status.body.installations?.[0]?.connectUrl,
    "Expected Feishu OAuth connect URL",
  );
  const state = requireTestValue(
    new URL(connectUrl).searchParams.get("state"),
    "Expected Feishu OAuth state",
  );
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  const oauthClient = setupApp({ context })(zeroFeishuOauthContract);
  await accept(
    oauthClient.callback({
      query: { code: "feishu-cli-oauth-code", state },
      extraHeaders: { cookie: "__session=opaque" },
    }),
    [307],
  );
  await flushWaitUntilForTest();
}

describe("POST /api/zero/integrations/feishu/message", () => {
  let captured: CapturedRequest[];

  beforeEach(() => {
    captured = [];
    mockEnv("VM0_WEB_URL", "https://www.vm0.test");
    mockEnv("APP_URL", "https://app.vm0.test");
    mockEnv("FEISHU_CALLBACK_BASE_URL", "https://www.vm0.test");
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
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
            open_id: "ou_feishu_cli_bot",
            app_name: "Feishu CLI Bot",
          },
        });
      }),
      http.post(
        "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
        () => {
          return HttpResponse.json({
            code: 0,
            access_token: "feishu-cli-user-access-token",
          });
        },
      ),
      http.get("https://open.feishu.cn/open-apis/authen/v1/user_info", () => {
        return HttpResponse.json({
          code: 0,
          data: {
            name: "Feishu CLI User",
            open_id: "ou_current_user",
            tenant_key: "tenant_feishu_cli",
          },
        });
      }),
      http.post(
        "https://open.feishu.cn/open-apis/im/v1/messages",
        async ({ request }) => {
          const body = (await request.json()) as FeishuRequestBody;
          const url = new URL(request.url);
          captured.push({
            kind: "send",
            receiveIdType: url.searchParams.get("receive_id_type"),
            target: body.receive_id ?? "",
            msgType: body.msg_type,
            content: JSON.parse(body.content) as Readonly<
              Record<string, unknown>
            >,
            replyInThread: false,
          });
          return HttpResponse.json({
            code: 0,
            data: {
              message_id: `om_${captured.length}`,
              chat_id: "oc_feishu_cli",
            },
          });
        },
      ),
      http.post(
        "https://open.feishu.cn/open-apis/im/v1/messages/:messageId/reply",
        async ({ params, request }) => {
          const body = (await request.json()) as FeishuRequestBody;
          captured.push({
            kind: "reply",
            receiveIdType: null,
            target: String(params.messageId),
            msgType: body.msg_type,
            content: JSON.parse(body.content) as Readonly<
              Record<string, unknown>
            >,
            replyInThread: body.reply_in_thread ?? false,
          });
          return HttpResponse.json({
            code: 0,
            data: {
              message_id: `om_${captured.length}`,
              chat_id: "oc_feishu_cli",
            },
          });
        },
      ),
    );
  });

  it("requires authentication and the feishu:write capability", async () => {
    const client = setupApp({ context })(integrationsFeishuMessageContract);
    const unauthenticated = await accept(
      client.sendMessage({
        headers: {},
        body: { chat: "oc_chat", text: "hello" },
      }),
      [401],
    );
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const forbidden = await accept(
      client.sendMessage({
        headers: {
          authorization: `Bearer ${sandboxToken({
            userId: `user_${randomUUID()}`,
            orgId: `org_${randomUUID()}`,
          })}`,
        },
        body: { chat: "oc_chat", text: "hello" },
      }),
      [403],
    );
    expect(forbidden.body.error.message).toContain("feishu:write");
  });

  it("sends chat, current-user, and threaded reply messages", async () => {
    const { actor, installationId } = await setupFeishuInstallation();
    await connectCurrentFeishuUser(actor);
    captured = [];
    const token = zeroToken(actor);
    const client = setupApp({ context })(integrationsFeishuMessageContract);

    const chat = await accept(
      client.sendMessage({
        headers: { authorization: `Bearer ${token}` },
        body: {
          installationId,
          chat: "oc_target_chat",
          text: "Hello chat",
        },
      }),
      [200],
    );
    expect(chat.body).toStrictEqual({
      ok: true,
      messageId: "om_1",
      chatId: "oc_feishu_cli",
    });

    await accept(
      client.sendMessage({
        headers: { authorization: `Bearer ${token}` },
        body: {
          installationId,
          user: "me",
          card: {
            schema: "2.0",
            body: { elements: [] },
          },
        },
      }),
      [200],
    );
    await accept(
      client.sendMessage({
        headers: { authorization: `Bearer ${token}` },
        body: {
          installationId,
          replyToMessageId: "om_parent",
          replyInThread: true,
          text: "Thread reply",
        },
      }),
      [200],
    );

    expect(captured).toStrictEqual([
      {
        kind: "send",
        receiveIdType: "chat_id",
        target: "oc_target_chat",
        msgType: "text",
        content: { text: "Hello chat" },
        replyInThread: false,
      },
      {
        kind: "send",
        receiveIdType: "open_id",
        target: "ou_current_user",
        msgType: "interactive",
        content: {
          schema: "2.0",
          body: { elements: [] },
        },
        replyInThread: false,
      },
      {
        kind: "reply",
        receiveIdType: null,
        target: "om_parent",
        msgType: "text",
        content: { text: "Thread reply" },
        replyInThread: true,
      },
    ]);
  });

  it("maps Feishu request and response failures to contract errors", async () => {
    const { actor, installationId } = await setupFeishuInstallation();
    let requestCount = 0;
    server.use(
      http.post("https://open.feishu.cn/open-apis/im/v1/messages", () => {
        requestCount += 1;
        return requestCount === 1
          ? HttpResponse.json({ code: 230_001, msg: "chat not found" })
          : HttpResponse.json({ code: 0, data: {} });
      }),
    );
    const client = setupApp({ context })(integrationsFeishuMessageContract);
    const headers = {
      authorization: `Bearer ${zeroToken(actor)}`,
    };
    const body = {
      installationId,
      chat: "oc_missing",
      text: "Hello",
    } as const;

    const rejected = await accept(client.sendMessage({ headers, body }), [400]);
    expect(rejected.body.error).toStrictEqual({
      code: "FEISHU_ERROR",
      message: "Feishu API error: chat not found",
    });

    const incomplete = await accept(
      client.sendMessage({ headers, body }),
      [502],
    );
    expect(incomplete.body.error).toStrictEqual({
      code: "FEISHU_ERROR",
      message: "Feishu API error: Feishu message response is incomplete",
    });
  });

  it("requires an explicit installation when multiple bots are configured", async () => {
    const first = await setupFeishuInstallation();
    await setupFeishuInstallation(first.actor);
    const client = setupApp({ context })(integrationsFeishuMessageContract);
    const token = zeroToken(first.actor);

    const ambiguous = await accept(
      client.sendMessage({
        headers: { authorization: `Bearer ${token}` },
        body: { chat: "oc_target_chat", text: "Choose a bot" },
      }),
      [400],
    );
    expect(ambiguous.body.error.message).toContain(
      "Multiple Feishu installations",
    );

    const selected = await accept(
      client.sendMessage({
        headers: { authorization: `Bearer ${token}` },
        body: {
          installationId: first.installationId,
          chat: "oc_target_chat",
          text: "Selected bot",
        },
      }),
      [200],
    );
    expect(selected.body.ok).toBeTruthy();
  });
});
