import { randomUUID } from "node:crypto";

import { zeroCodexDeviceAuthContract } from "@vm0/api-contracts/contracts/zero-codex-device-auth";
import { connectorCliAuthSessions } from "@vm0/db/schema/connector-cli-auth-session";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { secrets } from "@vm0/db/schema/secret";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { clearMockedEnv, mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import {
  decryptSecretValue,
  inspectPersistentSecretCiphertext,
  resetSecretKmsClientForTests,
  setSecretKmsClientForTests,
} from "../../services/crypto.utils";
import { fakeKmsClient } from "./helpers/fake-kms-client";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const ORG_SENTINEL_USER_ID = "__org__";

function client() {
  return setupApp({ context })(zeroCodexDeviceAuthContract);
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = base64UrlEncode(JSON.stringify(payload));
  return `${header}.${body}.fake-signature`;
}

function makeIdToken(opts: {
  readonly accountId: string;
  readonly planType: string;
  readonly workspaceName: string;
}): string {
  return makeJwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: opts.accountId,
      chatgpt_plan_type: opts.planType,
      organization: { title: opts.workspaceName },
    },
    exp: Math.floor(now() / 1000) + 3600,
  });
}

function makeAccessToken(): string {
  const accessExp = Math.floor(now() / 1000) + 7200;
  return makeJwt({ exp: accessExp });
}

function makeTokenResponse(scope: "org" | "personal") {
  return {
    access_token: makeAccessToken(),
    refresh_token: `rt_${scope}_synthetic_high_entropy`,
    id_token: makeIdToken({
      accountId: `ws_acct_from_id_token_${scope}`,
      planType: "plus",
      workspaceName: scope === "org" ? "Org Acme" : "Personal Acme",
    }),
  };
}

function mockCodexDeviceAuthHttp(
  args: {
    readonly tokenScope?: "org" | "personal";
    readonly deviceTokenStatus?: "pending" | "complete";
  } = {},
) {
  const calls = {
    userCode: [] as unknown[],
    deviceToken: [] as unknown[],
    oauthToken: [] as URLSearchParams[],
  };

  server.use(
    http.post(
      "https://auth.openai.com/api/accounts/deviceauth/usercode",
      async ({ request }) => {
        calls.userCode.push(await request.json());
        return HttpResponse.json({
          device_auth_id: "device_auth_test",
          user_code: "ABCD-EFGH",
          interval: "5",
        });
      },
    ),
    http.post(
      "https://auth.openai.com/api/accounts/deviceauth/token",
      async ({ request }) => {
        calls.deviceToken.push(await request.json());
        if (args.deviceTokenStatus === "pending") {
          return HttpResponse.json(
            { error: "authorization_pending" },
            { status: 403 },
          );
        }
        return HttpResponse.json({
          authorization_code: "auth_code_test",
          code_challenge: "code_challenge_test",
          code_verifier: "code_verifier_test",
        });
      },
    ),
    http.post("https://auth.openai.com/oauth/token", async ({ request }) => {
      calls.oauthToken.push(new URLSearchParams(await request.text()));
      return HttpResponse.json(makeTokenResponse(args.tokenScope ?? "org"));
    }),
  );

  return calls;
}

function expectDeviceTokenBody(calls: {
  readonly deviceToken: readonly unknown[];
}) {
  expect(calls.deviceToken).toStrictEqual([
    {
      device_auth_id: "device_auth_test",
      user_code: "ABCD-EFGH",
    },
  ]);
}

function expectOAuthTokenBody(calls: {
  readonly oauthToken: readonly URLSearchParams[];
}) {
  expect(calls.oauthToken).toHaveLength(1);
  const body = calls.oauthToken[0];
  expect(body?.get("grant_type")).toBe("authorization_code");
  expect(body?.get("code")).toBe("auth_code_test");
  expect(body?.get("redirect_uri")).toBe(
    "https://auth.openai.com/deviceauth/callback",
  );
  expect(body?.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
  expect(body?.get("code_verifier")).toBe("code_verifier_test");
}

async function cleanupUser(userId: string, orgId: string) {
  const db = store.set(writeDb$);
  await db
    .delete(connectorCliAuthSessions)
    .where(
      and(
        eq(connectorCliAuthSessions.userId, userId),
        eq(connectorCliAuthSessions.orgId, orgId),
      ),
    );
  await db
    .delete(modelProviders)
    .where(
      and(eq(modelProviders.orgId, orgId), eq(modelProviders.userId, userId)),
    );
  await db
    .delete(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
      ),
    );
  await db
    .delete(secrets)
    .where(and(eq(secrets.userId, userId), eq(secrets.orgId, orgId)));
  await db
    .delete(secrets)
    .where(
      and(eq(secrets.userId, ORG_SENTINEL_USER_ID), eq(secrets.orgId, orgId)),
    );
}

function codexDeviceAuthSessions(userId: string, orgId: string) {
  return store
    .set(writeDb$)
    .select()
    .from(connectorCliAuthSessions)
    .where(
      and(
        eq(connectorCliAuthSessions.userId, userId),
        eq(connectorCliAuthSessions.orgId, orgId),
        eq(connectorCliAuthSessions.connectorType, "codex-oauth-token"),
        eq(connectorCliAuthSessions.source, "codex-device-auth"),
      ),
    );
}

async function chatgptSecret(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
}) {
  const [secret] = await store
    .set(writeDb$)
    .select({ encryptedValue: secrets.encryptedValue })
    .from(secrets)
    .where(
      and(
        eq(secrets.orgId, args.orgId),
        eq(secrets.userId, args.userId),
        eq(secrets.name, args.name),
        eq(secrets.type, "model-provider"),
      ),
    )
    .limit(1);
  return secret ? decryptSecretValue(secret.encryptedValue) : null;
}

describe("Codex device auth routes", () => {
  const fixtures: { readonly userId: string; readonly orgId: string }[] = [];

  afterEach(async () => {
    clearMockedEnv();
    resetSecretKmsClientForTests();
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await cleanupUser(fixture.userId, fixture.orgId);
      }
    }
  });

  function setupUser(role: "org:admin" | "org:member" = "org:admin") {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    fixtures.push({ userId, orgId });
    mocks.clerk.session(userId, orgId, role);
    return { userId, orgId };
  }

  it("rejects member org-scope starts before contacting OpenAI auth", async () => {
    const { userId, orgId } = setupUser("org:member");
    const calls = mockCodexDeviceAuthHttp();

    const response = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { scope: "org" },
      }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
    await expect(codexDeviceAuthSessions(userId, orgId)).resolves.toStrictEqual(
      [],
    );
    expect(calls.userCode).toHaveLength(0);
  });

  it("starts Codex device auth and returns browser confirmation details", async () => {
    const { userId, orgId } = setupUser();
    const kms = fakeKmsClient();
    setSecretKmsClientForTests(kms.client);
    mockEnv("SECRETS_KMS_KEY_ID", "alias/vm0-secrets");
    const calls = mockCodexDeviceAuthHttp();

    const response = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { scope: "org" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      type: "codex",
      status: "pending",
      scope: "org",
      browserUrl: "https://auth.openai.com/codex/device",
      verificationCode: "ABCD-EFGH",
      interval: 5,
    });
    expect(calls.userCode).toStrictEqual([
      { client_id: "app_EMoamEEZ73f0CkXaXp7hrann" },
    ]);

    const sessions = await codexDeviceAuthSessions(userId, orgId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      connectorType: "codex-oauth-token",
      source: "codex-device-auth",
      status: "awaiting_user_approval",
      sandboxId: null,
      approvalUrl: "https://auth.openai.com/codex/device",
      verificationCode: "ABCD-EFGH",
      errorMessage: null,
    });
    expect(sessions[0]?.encryptedProviderState).toBeTruthy();
    expect(
      inspectPersistentSecretCiphertext(sessions[0]!.encryptedProviderState!),
    ).toStrictEqual({
      format: "dual",
      hasLegacy: true,
      hasKms: true,
    });
    expect(kms.calls).toHaveLength(1);
  });

  it("cancels pending device auth", async () => {
    const { userId, orgId } = setupUser();
    mockCodexDeviceAuthHttp();

    const start = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { scope: "org" },
      }),
      [200],
    );
    const cancel = await accept(
      client().cancel({
        headers: { authorization: "Bearer clerk-session" },
        body: { sessionToken: start.body.sessionToken },
      }),
      [200],
    );

    expect(cancel.body).toStrictEqual({ status: "cancelled" });

    const sessions = await codexDeviceAuthSessions(userId, orgId);
    expect(sessions[0]).toMatchObject({
      status: "cancelled",
      approvalUrl: null,
      verificationCode: null,
      errorMessage: "Codex device auth session was cancelled",
    });
    expect(sessions[0]?.cancelledAt).toBeInstanceOf(Date);
  });

  it("completes org-scope device auth and imports ChatGPT secrets", async () => {
    const { userId, orgId } = setupUser();
    const calls = mockCodexDeviceAuthHttp({ tokenScope: "org" });

    const start = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { scope: "org" },
      }),
      [200],
    );
    const complete = await accept(
      client().complete({
        headers: { authorization: "Bearer clerk-session" },
        body: { sessionToken: start.body.sessionToken },
      }),
      [200],
    );

    expect(complete.body).toMatchObject({
      status: "complete",
      created: true,
      provider: {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        workspaceName: "Org Acme",
        planType: "plus",
      },
    });
    expectDeviceTokenBody(calls);
    expectOAuthTokenBody(calls);
    await expect(
      chatgptSecret({
        orgId,
        userId: ORG_SENTINEL_USER_ID,
        name: "CHATGPT_REFRESH_TOKEN",
      }),
    ).resolves.toBe("rt_org_synthetic_high_entropy");

    const sessions = await codexDeviceAuthSessions(userId, orgId);
    expect(sessions[0]?.status).toBe("imported");
  });

  it("completes personal-scope device auth for non-admin members", async () => {
    const { userId, orgId } = setupUser("org:member");
    const calls = mockCodexDeviceAuthHttp({ tokenScope: "personal" });

    const start = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { scope: "personal" },
      }),
      [200],
    );
    const complete = await accept(
      client().complete({
        headers: { authorization: "Bearer clerk-session" },
        body: { sessionToken: start.body.sessionToken },
      }),
      [200],
    );

    expect(complete.body).toMatchObject({
      status: "complete",
      provider: {
        type: "codex-oauth-token",
        workspaceName: "Personal Acme",
      },
    });
    expectDeviceTokenBody(calls);
    expectOAuthTokenBody(calls);
    await expect(
      chatgptSecret({
        orgId,
        userId,
        name: "CHATGPT_REFRESH_TOKEN",
      }),
    ).resolves.toBe("rt_personal_synthetic_high_entropy");
  });
});
