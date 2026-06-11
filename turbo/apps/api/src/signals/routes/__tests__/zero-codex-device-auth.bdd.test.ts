import { randomUUID } from "node:crypto";

import { zeroCodexDeviceAuthContract } from "@vm0/api-contracts/contracts/zero-codex-device-auth";
import { modelProviderAuthSessions } from "@vm0/db/schema/model-provider-auth-session";
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
  decryptStoredSecretValue,
  resetSecretKmsClientForTests,
  setSecretKmsClientForTests,
} from "../../services/crypto.utils";
import { isKmsSecretForTests } from "./helpers/encrypt-secret";
import { fakeKmsClient } from "./helpers/fake-kms-client";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

// BDD migration of the legacy `zero-codex-device-auth.test.ts`.
// The 5 legacy `it()`s collapse into 2 BDD `it()`s:
// (1) reject member + start chain (403 member
// org-scope start before contacting OpenAI auth → 200
// start returns browser confirmation details + persists
// an awaiting_user_approval session + encrypts the
// provider state),
// (2) cancel + complete chain (200 cancel pending
// session → 200 complete org-scope imports ChatGPT
// secrets → 200 complete personal-scope for non-admin).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const ORG_SENTINEL_USER_ID = "__org__";

function apiClient() {
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
    .delete(modelProviderAuthSessions)
    .where(
      and(
        eq(modelProviderAuthSessions.userId, userId),
        eq(modelProviderAuthSessions.orgId, orgId),
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
    .from(modelProviderAuthSessions)
    .where(
      and(
        eq(modelProviderAuthSessions.userId, userId),
        eq(modelProviderAuthSessions.orgId, orgId),
        eq(modelProviderAuthSessions.connectorType, "codex-oauth-token"),
        eq(modelProviderAuthSessions.source, "codex-device-auth"),
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
  return secret ? await decryptStoredSecretValue(secret.encryptedValue) : null;
}

function sessionHeaders() {
  return { authorization: "Bearer clerk-session" };
}

describe("BDD Codex device auth — reject member + start chain", () => {
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

  it("gwt-wt-wt: 403 member org-scope start before contacting OpenAI auth → 200 start returns browser confirmation details + persists an awaiting_user_approval session + encrypts the provider state", async () => {
    // Given: a member session + the OpenAI device-auth
    // endpoints mocked.

    // When + Then: 403 — the org-scope start is
    // rejected before any OpenAI HTTP call is made +
    // no auth session row is created.
    const memberFixture = setupUser("org:member");
    const memberCalls = mockCodexDeviceAuthHttp();
    const memberResponse = await accept(
      apiClient().start({
        headers: sessionHeaders(),
        body: { scope: "org" },
      }),
      [403],
    );
    expect(memberResponse.body.error.code).toBe("FORBIDDEN");
    await expect(
      codexDeviceAuthSessions(memberFixture.userId, memberFixture.orgId),
    ).resolves.toStrictEqual([]);
    expect(memberCalls.userCode).toHaveLength(0);

    // Given: an admin session + KMS client +
    // SECRETS_KMS_KEY_ID + the OpenAI device-auth
    // endpoints mocked.

    // When + Then: 200 — start returns the browser
    // URL, verification code, interval, and scope +
    // the usercode endpoint is called with the
    // expected client_id + an
    // awaiting_user_approval session is persisted +
    // the provider state is encrypted.
    const startFixture = setupUser();
    const kms = fakeKmsClient();
    setSecretKmsClientForTests(kms.client);
    mockEnv("SECRETS_KMS_KEY_ID", "alias/vm0-secrets");
    const startCalls = mockCodexDeviceAuthHttp();

    const startResponse = await accept(
      apiClient().start({
        headers: sessionHeaders(),
        body: { scope: "org" },
      }),
      [200],
    );

    expect(startResponse.body).toMatchObject({
      type: "codex",
      status: "pending",
      scope: "org",
      browserUrl: "https://auth.openai.com/codex/device",
      verificationCode: "ABCD-EFGH",
      interval: 5,
    });
    expect(startCalls.userCode).toStrictEqual([
      { client_id: "app_EMoamEEZ73f0CkXaXp7hrann" },
    ]);

    const sessions = await codexDeviceAuthSessions(
      startFixture.userId,
      startFixture.orgId,
    );
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
      isKmsSecretForTests(sessions[0]!.encryptedProviderState!),
    ).toBeTruthy();
    expect(kms.calls).toHaveLength(1);
  });
});

describe("BDD Codex device auth — cancel + complete chain", () => {
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

  it("gwt-wt-wt: 200 cancel pending session → 200 complete org-scope imports ChatGPT secrets → 200 complete personal-scope for non-admin", async () => {
    // Given: an admin session + the OpenAI
    // device-auth endpoints mocked.

    // When + Then: cancel marks the session
    // cancelled with a non-null cancelledAt + clears
    // the approval URL + verification code +
    // errorMessage.
    const cancelFixture = setupUser();
    mockCodexDeviceAuthHttp();

    const cancelStart = await accept(
      apiClient().start({
        headers: sessionHeaders(),
        body: { scope: "org" },
      }),
      [200],
    );
    const cancelResponse = await accept(
      apiClient().cancel({
        headers: sessionHeaders(),
        body: { sessionToken: cancelStart.body.sessionToken },
      }),
      [200],
    );
    expect(cancelResponse.body).toStrictEqual({ status: "cancelled" });

    const cancelSessions = await codexDeviceAuthSessions(
      cancelFixture.userId,
      cancelFixture.orgId,
    );
    expect(cancelSessions[0]).toMatchObject({
      status: "cancelled",
      approvalUrl: null,
      verificationCode: null,
      errorMessage: "Codex device auth session was cancelled",
    });
    expect(cancelSessions[0]?.cancelledAt).toBeInstanceOf(Date);

    // Given: an admin session + the OpenAI
    // device-auth endpoints mocked with org-scope
    // tokens.

    // When + Then: complete returns
    // status=complete + created=true with the org
    // workspace name + the org-scope refresh token
    // is imported as a ChatGPT secret for the org
    // sentinel user + the session moves to imported.
    const orgFixture = setupUser();
    const orgCalls = mockCodexDeviceAuthHttp({ tokenScope: "org" });

    const orgStart = await accept(
      apiClient().start({
        headers: sessionHeaders(),
        body: { scope: "org" },
      }),
      [200],
    );
    const orgComplete = await accept(
      apiClient().complete({
        headers: sessionHeaders(),
        body: { sessionToken: orgStart.body.sessionToken },
      }),
      [200],
    );
    expect(orgComplete.body).toMatchObject({
      status: "complete",
      created: true,
      provider: {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        workspaceName: "Org Acme",
        planType: "plus",
      },
    });
    expectDeviceTokenBody(orgCalls);
    expectOAuthTokenBody(orgCalls);
    await expect(
      chatgptSecret({
        orgId: orgFixture.orgId,
        userId: ORG_SENTINEL_USER_ID,
        name: "CHATGPT_REFRESH_TOKEN",
      }),
    ).resolves.toBe("rt_org_synthetic_high_entropy");

    const orgSessions = await codexDeviceAuthSessions(
      orgFixture.userId,
      orgFixture.orgId,
    );
    expect(orgSessions[0]?.status).toBe("imported");

    // Given: a non-admin session + the OpenAI
    // device-auth endpoints mocked with
    // personal-scope tokens.

    // When + Then: complete returns
    // status=complete with the personal workspace
    // name + the personal-scope refresh token is
    // imported for the calling member user.
    const personalFixture = setupUser("org:member");
    const personalCalls = mockCodexDeviceAuthHttp({ tokenScope: "personal" });

    const personalStart = await accept(
      apiClient().start({
        headers: sessionHeaders(),
        body: { scope: "personal" },
      }),
      [200],
    );
    const personalComplete = await accept(
      apiClient().complete({
        headers: sessionHeaders(),
        body: { sessionToken: personalStart.body.sessionToken },
      }),
      [200],
    );
    expect(personalComplete.body).toMatchObject({
      status: "complete",
      provider: {
        type: "codex-oauth-token",
        workspaceName: "Personal Acme",
      },
    });
    expectDeviceTokenBody(personalCalls);
    expectOAuthTokenBody(personalCalls);
    await expect(
      chatgptSecret({
        orgId: personalFixture.orgId,
        userId: personalFixture.userId,
        name: "CHATGPT_REFRESH_TOKEN",
      }),
    ).resolves.toBe("rt_personal_synthetic_high_entropy");
  });
});
