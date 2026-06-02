import { createHash, randomUUID } from "node:crypto";

import { zeroConnectorOauthDeviceAuthSessionContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { getConnectorAuthMethodDeviceAuthGrantConfig } from "@vm0/connectors/connector-utils";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { testOauthDeviceProvider } from "@vm0/connectors/auth-providers/oauth/providers/test-oauth-device-provider";
import { connectors } from "@vm0/db/schema/connector";
import { connectorOauthDeviceAuthorizationSessions } from "@vm0/db/schema/connector-oauth-device-authorization-session";
import { secrets } from "@vm0/db/schema/secret";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { clearMockedEnv, mockEnv } from "../../../lib/env";
import { now, nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import {
  decryptPersistentSecretValue,
  decryptStoredSecretValue,
  encryptPersistentSecretValue,
  resetSecretKmsClientForTests,
  setSecretKmsClientForTests,
} from "../../services/crypto.utils";
import { isKmsSecretForTests } from "./helpers/encrypt-secret";
import { fakeKmsClient } from "./helpers/fake-kms-client";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const originalPollDeviceAuth = testOauthDeviceProvider.grant.pollDeviceAuth;
const TEST_OAUTH_DEVICE_CODE_URL =
  "http://localhost:3000/api/test/oauth-provider/device/code";
const TEST_OAUTH_TOKEN_URL =
  "http://localhost:3000/api/test/oauth-provider/token";
const TEST_OAUTH_DEVICE_CLIENT_ID = "test-oauth-device-client";
const TEST_OAUTH_DEVICE_API_CLIENT_ID = "test-oauth-device-api-client";
const BASE44_DEVICE_CODE_URL = "https://app.base44.com/oauth/device/code";
const BASE44_TOKEN_URL = "https://app.base44.com/oauth/token";
const BASE44_USERINFO_URL = "https://app.base44.com/oauth/userinfo";
const SLOCK_DEVICE_CODE_URL = "https://api.slock.ai/api/auth/device/authorize";
const SLOCK_TOKEN_URL = "https://api.slock.ai/api/auth/device/token";
const SLOCK_USERINFO_URL = "https://api.slock.ai/api/auth/me";
const SLOCK_SERVERS_URL = "https://api.slock.ai/api/servers";
const SLOCK_ACCESS_TOKEN_TTL_SECONDS = 900;
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

function sessionTokenHash(sessionToken: string): string {
  return createHash("sha256").update(sessionToken).digest("hex");
}

function jwtAccessToken(subject: string): string {
  const issuedAt = Math.floor(now() / 1000);
  const encode = (value: unknown) => {
    return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  };
  return [
    encode({ alg: "none", typ: "JWT" }),
    encode({
      sub: subject,
      type: "access",
      iat: issuedAt,
      exp: issuedAt + SLOCK_ACCESS_TOKEN_TTL_SECONDS,
    }),
    "signature",
  ].join(".");
}

async function enableTestOauthDevice(userId: string, orgId: string) {
  await store
    .set(writeDb$)
    .insert(userFeatureSwitches)
    .values({
      orgId,
      userId,
      switches: { [FeatureSwitchKey.TestOauthConnector]: true },
    })
    .onConflictDoUpdate({
      target: [userFeatureSwitches.orgId, userFeatureSwitches.userId],
      set: { switches: { [FeatureSwitchKey.TestOauthConnector]: true } },
    });
}

async function cleanupUser(userId: string, orgId: string) {
  const db = store.set(writeDb$);
  await db
    .delete(connectorOauthDeviceAuthorizationSessions)
    .where(
      and(
        eq(connectorOauthDeviceAuthorizationSessions.userId, userId),
        eq(connectorOauthDeviceAuthorizationSessions.orgId, orgId),
      ),
    );
  await db
    .delete(connectors)
    .where(and(eq(connectors.userId, userId), eq(connectors.orgId, orgId)));
  await db
    .delete(secrets)
    .where(and(eq(secrets.userId, userId), eq(secrets.orgId, orgId)));
  await db
    .delete(userFeatureSwitches)
    .where(
      and(
        eq(userFeatureSwitches.userId, userId),
        eq(userFeatureSwitches.orgId, orgId),
      ),
    );
}

async function encryptedProviderState(args: {
  readonly connectorType?: "test-oauth-device" | "slock";
  readonly deviceCode: string;
}): Promise<string> {
  return await encryptPersistentSecretValue(
    JSON.stringify({
      connectorType: args.connectorType ?? "test-oauth-device",
      deviceCode: args.deviceCode,
    }),
    {},
  );
}

function mockTestOAuthDeviceProvider(): void {
  server.use(
    http.post(TEST_OAUTH_DEVICE_CODE_URL, async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      return HttpResponse.json({
        device_code: `test-device:${body.get("client_id")}:${body.get("scope")}`,
        user_code: "TEST-DEVICE",
        verification_uri: "https://oauth-device.test/device",
        verification_uri_complete:
          "https://oauth-device.test/device?user_code=TEST-DEVICE",
        expires_in: 600,
        interval: 0,
      });
    }),
    http.post(TEST_OAUTH_TOKEN_URL, async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      if (body.get("grant_type") !== DEVICE_CODE_GRANT_TYPE) {
        return HttpResponse.json(
          { error: "unsupported_grant_type" },
          { status: 400 },
        );
      }

      const deviceCode = body.get("device_code");
      if (deviceCode === "pending") {
        return HttpResponse.json(
          { error: "authorization_pending" },
          { status: 400 },
        );
      }
      if (deviceCode === "slow-down") {
        return HttpResponse.json({ error: "slow_down" }, { status: 400 });
      }
      if (deviceCode === "denied") {
        return HttpResponse.json(
          {
            error: "access_denied",
            error_description: "User denied the device authorization request",
          },
          { status: 400 },
        );
      }
      if (deviceCode === "expired") {
        return HttpResponse.json(
          {
            error: "expired_token",
            error_description: "Device authorization expired",
          },
          { status: 400 },
        );
      }
      if (deviceCode === "error") {
        return HttpResponse.json(
          {
            error: "invalid_request",
            error_description: "Synthetic device authorization error",
          },
          { status: 400 },
        );
      }
      if (
        !deviceCode?.startsWith(
          `test-device:${TEST_OAUTH_DEVICE_CLIENT_ID}:`,
        ) &&
        !deviceCode?.startsWith(
          `test-device:${TEST_OAUTH_DEVICE_API_CLIENT_ID}:`,
        )
      ) {
        return HttpResponse.json(
          {
            error: "invalid_grant",
            error_description: "Unknown device authorization code",
          },
          { status: 400 },
        );
      }

      return HttpResponse.json({
        access_token: `test-device-access:${body.get("client_id")}:${deviceCode}`,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "read",
      });
    }),
  );
}

function mockBase44OAuthProvider(): void {
  server.use(
    http.post(BASE44_DEVICE_CODE_URL, async ({ request }) => {
      await expect(request.json()).resolves.toStrictEqual({
        client_id: "base44_cli",
        scope: "apps:read apps:write offline",
      });
      return HttpResponse.json({
        device_code: "base44-device-code",
        user_code: "BASE-44",
        verification_uri: "https://app.base44.com/device",
        verification_uri_complete:
          "https://app.base44.com/device?user_code=BASE-44",
        expires_in: 600,
        interval: 0,
      });
    }),
    http.post(BASE44_TOKEN_URL, async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      expect(body.get("grant_type")).toBe(DEVICE_CODE_GRANT_TYPE);
      expect(body.get("client_id")).toBe("base44_cli");
      expect(body.get("device_code")).toBe("base44-device-code");
      return HttpResponse.json({
        access_token: "base44-access-token",
        refresh_token: "base44-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "apps:read apps:write offline",
      });
    }),
    http.get(BASE44_USERINFO_URL, ({ request }) => {
      expect(request.headers.get("authorization")).toBe(
        "Bearer base44-access-token",
      );
      return HttpResponse.json({
        sub: "base44-user-id",
        name: "Base44 User",
        email: "base44@example.com",
      });
    }),
  );
}

function mockSlockOAuthProvider(): { readonly accessToken: string } {
  const accessToken = jwtAccessToken("slock-user-id");
  server.use(
    http.post(SLOCK_DEVICE_CODE_URL, async ({ request }) => {
      await expect(request.json()).resolves.toStrictEqual({});
      return HttpResponse.json({
        deviceCode: "slock-device-code",
        userCode: "SLOCK-1",
        verificationUri: "https://api.slock.ai/device",
        expiresIn: 600,
        interval: 0,
      });
    }),
    http.post(SLOCK_TOKEN_URL, async ({ request }) => {
      const body = await request.json();
      const deviceCode = z
        .object({ deviceCode: z.string() })
        .parse(body).deviceCode;
      expect(body).toStrictEqual({ deviceCode });
      if (deviceCode === "userinfo-error") {
        return HttpResponse.json({
          accessToken: "slock-access-userinfo-error",
          refreshToken: "slock-refresh-token",
          userId: "slock-user-id",
        });
      }
      expect(deviceCode).toBe("slock-device-code");
      return HttpResponse.json({
        accessToken,
        refreshToken: "slock-refresh-token",
        userId: "slock-user-id",
      });
    }),
    http.get(SLOCK_SERVERS_URL, ({ request }) => {
      const authorization = request.headers.get("authorization");
      if (authorization !== "Bearer slock-access-userinfo-error") {
        expect(authorization).toBe(`Bearer ${accessToken}`);
      }
      return HttpResponse.json([
        {
          id: "slock-server-id",
          name: "Primary",
        },
      ]);
    }),
    http.get(SLOCK_USERINFO_URL, ({ request }) => {
      const authorization = request.headers.get("authorization");
      if (authorization === "Bearer slock-access-userinfo-error") {
        return HttpResponse.json(
          { code: "userinfo_lookup_failed" },
          { status: 500 },
        );
      }
      expect(authorization).toBe(`Bearer ${accessToken}`);
      return HttpResponse.json({
        id: "slock-user-id",
        name: "Slock User",
        email: "slock@example.com",
      });
    }),
  );
  return { accessToken };
}

async function createSession(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly connectorType?: "test-oauth-device" | "slock";
  readonly authMethod?: string;
  readonly deviceCode: string;
  readonly status?: "awaiting_user_authorization" | "polling";
  readonly intervalSeconds?: number;
  readonly updatedAt?: Date;
  readonly expiresAt?: Date;
}): Promise<{ readonly id: string; readonly sessionToken: string }> {
  const sessionToken = `session-token-${randomUUID()}`;
  const now = nowDate();
  const pollableAt = new Date(now.getTime() - 10_000);
  const [session] = await store
    .set(writeDb$)
    .insert(connectorOauthDeviceAuthorizationSessions)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      connectorType: args.connectorType ?? "test-oauth-device",
      authMethod: args.authMethod ?? "oauth",
      status: args.status ?? "awaiting_user_authorization",
      sessionTokenHash: sessionTokenHash(sessionToken),
      encryptedProviderState: await encryptedProviderState({
        connectorType: args.connectorType ?? "test-oauth-device",
        deviceCode: args.deviceCode,
      }),
      userCode: "TEST-DEVICE",
      verificationUri: "https://oauth-device.test/device",
      verificationUriComplete:
        "https://oauth-device.test/device?user_code=TEST-DEVICE",
      intervalSeconds: args.intervalSeconds ?? 5,
      updatedAt: args.updatedAt ?? pollableAt,
      expiresAt: args.expiresAt ?? new Date(now.getTime() + 600_000),
    })
    .returning({ id: connectorOauthDeviceAuthorizationSessions.id });

  if (!session) {
    throw new Error("Failed to create OAuth device test session");
  }
  return { id: session.id, sessionToken };
}

async function makeSessionPollable(id: string): Promise<void> {
  await store
    .set(writeDb$)
    .update(connectorOauthDeviceAuthorizationSessions)
    .set({ updatedAt: new Date(nowDate().getTime() - 10_000) })
    .where(eq(connectorOauthDeviceAuthorizationSessions.id, id));
}

async function onlySession(id: string) {
  const [session] = await store
    .set(writeDb$)
    .select()
    .from(connectorOauthDeviceAuthorizationSessions)
    .where(eq(connectorOauthDeviceAuthorizationSessions.id, id));
  if (!session) {
    throw new Error("Expected OAuth device session");
  }
  return session;
}

async function connectorAccessToken(userId: string, orgId: string) {
  return await connectorSecretValue(
    userId,
    orgId,
    "TEST_OAUTH_DEVICE_ACCESS_TOKEN",
  );
}

async function connectorSecretValue(
  userId: string,
  orgId: string,
  name: string,
) {
  const [secret] = await store
    .set(writeDb$)
    .select({ encryptedValue: secrets.encryptedValue })
    .from(secrets)
    .where(
      and(
        eq(secrets.orgId, orgId),
        eq(secrets.userId, userId),
        eq(secrets.name, name),
      ),
    );
  return secret ? await decryptStoredSecretValue(secret.encryptedValue) : null;
}

describe("OAuth device authorization connector routes", () => {
  const users: { readonly userId: string; readonly orgId: string }[] = [];

  afterEach(async () => {
    clearMockedEnv();
    resetSecretKmsClientForTests();
    testOauthDeviceProvider.grant.pollDeviceAuth = originalPollDeviceAuth;
    while (users.length > 0) {
      const user = users.pop();
      if (user) {
        await cleanupUser(user.userId, user.orgId);
      }
    }
  });

  async function setupUser() {
    mockTestOAuthDeviceProvider();
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    users.push({ userId, orgId });
    mocks.clerk.session(userId, orgId);
    await enableTestOauthDevice(userId, orgId);
    return { userId, orgId };
  }

  it("starts a session and stores only encrypted provider state plus a token hash", async () => {
    const { userId, orgId } = await setupUser();
    const kms = fakeKmsClient();
    setSecretKmsClientForTests(kms.client);
    mockEnv("SECRETS_KMS_KEY_ID", "alias/vm0-secrets");
    const client = setupApp({ context })(
      zeroConnectorOauthDeviceAuthSessionContract,
    );

    const response = await accept(
      client.create({
        params: { type: "test-oauth-device" },
        body: { authMethod: "oauth" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      type: "test-oauth-device",
      status: "pending",
      userCode: "TEST-DEVICE",
      verificationUri: "https://oauth-device.test/device",
      verificationUriComplete:
        "https://oauth-device.test/device?user_code=TEST-DEVICE",
      expiresIn: 600,
      interval: 0,
    });
    expect(JSON.stringify(response.body)).not.toContain("test-device:");

    const session = await onlySession(response.body.sessionId);
    expect(session.orgId).toBe(orgId);
    expect(session.userId).toBe(userId);
    expect(session.authMethod).toBe("oauth");
    expect(session.status).toBe("awaiting_user_authorization");
    expect(session.sessionTokenHash).toBe(
      sessionTokenHash(response.body.sessionToken),
    );
    expect(session.encryptedProviderState).not.toContain("test-device:");
    expect(isKmsSecretForTests(session.encryptedProviderState)).toBeTruthy();
    const decryptedProviderState = await decryptPersistentSecretValue(
      session.encryptedProviderState,
      {
        orgId,
        userId,
      },
    );
    expect(decryptedProviderState).toContain(
      "test-device:test-oauth-device-client:read",
    );
    expect(decryptedProviderState).not.toContain("scopes");
    expect(kms.calls).toHaveLength(2);
  });

  it("marks the previous active session as superseded when a new session starts", async () => {
    const { userId, orgId } = await setupUser();
    const client = setupApp({ context })(
      zeroConnectorOauthDeviceAuthSessionContract,
    );

    const first = await accept(
      client.create({
        params: { type: "test-oauth-device" },
        body: { authMethod: "oauth" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const second = await accept(
      client.create({
        params: { type: "test-oauth-device" },
        body: { authMethod: "oauth" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    await expect(onlySession(first.body.sessionId)).resolves.toMatchObject({
      orgId,
      userId,
      status: "error",
      errorCode: "session_superseded",
      errorMessage: "OAuth device authorization session was superseded",
    });
    await expect(onlySession(second.body.sessionId)).resolves.toMatchObject({
      orgId,
      userId,
      status: "awaiting_user_authorization",
    });

    const stalePoll = await accept(
      client.poll({
        params: {
          type: "test-oauth-device",
          sessionId: first.body.sessionId,
        },
        body: { sessionToken: first.body.sessionToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(stalePoll.body).toStrictEqual({
      status: "error",
      errorCode: "session_superseded",
      errorMessage: "OAuth device authorization session was superseded",
    });
  });

  it("does not supersede active sessions for a different auth method", async () => {
    const { userId, orgId } = await setupUser();
    const client = setupApp({ context })(
      zeroConnectorOauthDeviceAuthSessionContract,
    );

    const oauthSession = await accept(
      client.create({
        params: { type: "test-oauth-device" },
        body: { authMethod: "oauth" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const apiSession = await accept(
      client.create({
        params: { type: "test-oauth-device" },
        body: { authMethod: "api" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    await expect(
      onlySession(oauthSession.body.sessionId),
    ).resolves.toMatchObject({
      orgId,
      userId,
      authMethod: "oauth",
      status: "awaiting_user_authorization",
    });
    await expect(onlySession(apiSession.body.sessionId)).resolves.toMatchObject(
      {
        orgId,
        userId,
        authMethod: "api",
        status: "awaiting_user_authorization",
      },
    );
  });

  it("does not persist a superseded session that completes after a new session starts", async () => {
    const { userId, orgId } = await setupUser();
    const client = setupApp({ context })(
      zeroConnectorOauthDeviceAuthSessionContract,
    );
    const first = await accept(
      client.create({
        params: { type: "test-oauth-device" },
        body: { authMethod: "oauth" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    await makeSessionPollable(first.body.sessionId);

    let releaseProviderPoll: (() => void) | undefined;
    const providerPollStarted = new Promise<void>((resolve) => {
      testOauthDeviceProvider.grant.pollDeviceAuth = async (args) => {
        resolve();
        await new Promise<void>((resolve) => {
          releaseProviderPoll = resolve;
        });
        return await originalPollDeviceAuth(args);
      };
    });
    const firstPoll = client.poll({
      params: {
        type: "test-oauth-device",
        sessionId: first.body.sessionId,
      },
      body: { sessionToken: first.body.sessionToken },
      headers: { authorization: "Bearer clerk-session" },
    });
    await providerPollStarted;

    const second = await accept(
      client.create({
        params: { type: "test-oauth-device" },
        body: { authMethod: "oauth" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    releaseProviderPoll?.();

    const stalePoll = await accept(firstPoll, [200]);
    expect(stalePoll.body).toStrictEqual({
      status: "error",
      errorCode: "session_superseded",
      errorMessage: "OAuth device authorization session was superseded",
    });
    await expect(connectorAccessToken(userId, orgId)).resolves.toBeNull();
    await expect(onlySession(first.body.sessionId)).resolves.toMatchObject({
      status: "error",
      errorCode: "session_superseded",
    });
    await expect(onlySession(second.body.sessionId)).resolves.toMatchObject({
      status: "awaiting_user_authorization",
    });
  });

  it("rejects auth-code grant connectors", async () => {
    await setupUser();
    const client = setupApp({ context })(
      zeroConnectorOauthDeviceAuthSessionContract,
    );

    const response = await accept(
      client.create({
        params: { type: "github" },
        body: { authMethod: "oauth" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body.error.message).toBe(
      "github connector does not support a device-auth grant",
    );
  });

  it("rejects connector without an auth-code or device-auth grants", async () => {
    await setupUser();
    const client = setupApp({ context })(
      zeroConnectorOauthDeviceAuthSessionContract,
    );

    const response = await accept(
      client.create({
        params: { type: "cloudinary" },
        body: { authMethod: "oauth" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body.error.message).toBe(
      "cloudinary connector does not use an auth-code or device-auth grant",
    );
  });

  it("rejects disabled OAuth auth methods", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    users.push({ userId, orgId });
    mocks.clerk.session(userId, orgId);
    const client = setupApp({ context })(
      zeroConnectorOauthDeviceAuthSessionContract,
    );

    const response = await accept(
      client.create({
        params: { type: "test-oauth-device" },
        body: { authMethod: "oauth" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body.error.message).toBe(
      "OAuth device authorization is not enabled for this connector",
    );
  });

  it("rejects selected auth methods that are not device-auth methods", async () => {
    const { userId, orgId } = await setupUser();
    const client = setupApp({ context })(
      zeroConnectorOauthDeviceAuthSessionContract,
    );

    const response = await accept(
      client.create({
        params: { type: "test-oauth-device" },
        body: { authMethod: "api-token" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body.error.message).toBe(
      "test-oauth-device connector does not have api-token auth method",
    );
    await expect(connectorAccessToken(userId, orgId)).resolves.toBeNull();
  });

  it("polls with the auth method stored on the session", async () => {
    const { userId, orgId } = await setupUser();
    const session = await createSession({
      userId,
      orgId,
      authMethod: "api-token",
      deviceCode: "pending",
    });
    const client = setupApp({ context })(
      zeroConnectorOauthDeviceAuthSessionContract,
    );

    const response = await accept(
      client.poll({
        params: { type: "test-oauth-device", sessionId: session.id },
        body: { sessionToken: session.sessionToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [500],
    );

    expect(response.body.error.message).toBe(
      "Invalid OAuth device authorization session",
    );
  });

  it("rejects polls when the stored auth method is no longer available", async () => {
    const { userId, orgId } = await setupUser();
    const session = await createSession({
      userId,
      orgId,
      deviceCode: "pending",
    });
    await store
      .set(writeDb$)
      .delete(userFeatureSwitches)
      .where(
        and(
          eq(userFeatureSwitches.userId, userId),
          eq(userFeatureSwitches.orgId, orgId),
        ),
      );
    const client = setupApp({ context })(
      zeroConnectorOauthDeviceAuthSessionContract,
    );

    const response = await accept(
      client.poll({
        params: { type: "test-oauth-device", sessionId: session.id },
        body: { sessionToken: session.sessionToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body.error.message).toBe(
      "OAuth device authorization is not enabled for this connector",
    );
  });

  it("polls pending and restores the session to awaiting authorization", async () => {
    const { userId, orgId } = await setupUser();
    const session = await createSession({
      userId,
      orgId,
      deviceCode: "pending",
    });
    const client = setupApp({ context })(
      zeroConnectorOauthDeviceAuthSessionContract,
    );

    const response = await accept(
      client.poll({
        params: { type: "test-oauth-device", sessionId: session.id },
        body: { sessionToken: session.sessionToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ status: "pending", interval: 5 });
    await expect(onlySession(session.id)).resolves.toMatchObject({
      status: "awaiting_user_authorization",
      intervalSeconds: 5,
    });
  });

  it("polls slow_down and updates the persisted interval", async () => {
    const { userId, orgId } = await setupUser();
    const session = await createSession({
      userId,
      orgId,
      deviceCode: "slow-down",
      intervalSeconds: 5,
    });
    const client = setupApp({ context })(
      zeroConnectorOauthDeviceAuthSessionContract,
    );

    const response = await accept(
      client.poll({
        params: { type: "test-oauth-device", sessionId: session.id },
        body: { sessionToken: session.sessionToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ status: "pending", interval: 10 });
    expect((await onlySession(session.id)).intervalSeconds).toBe(10);
  });

  it("completes a session through connector token persistence without leaking tokens", async () => {
    const { userId, orgId } = await setupUser();
    const client = setupApp({ context })(
      zeroConnectorOauthDeviceAuthSessionContract,
    );
    const start = await accept(
      client.create({
        params: { type: "test-oauth-device" },
        body: { authMethod: "oauth" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    testOauthDeviceProvider.grant.pollDeviceAuth = async (args) => {
      const result = await originalPollDeviceAuth(args);
      if (result.status !== "complete") {
        return result;
      }
      return {
        ...result,
        token: { ...result.token, scopes: ["read", "granted"] },
      };
    };

    const response = await accept(
      client.poll({
        params: {
          type: "test-oauth-device",
          sessionId: start.body.sessionId,
        },
        body: { sessionToken: start.body.sessionToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.status).toBe("complete");
    expect(JSON.stringify(response.body)).not.toContain("test-device-access");
    await expect(connectorAccessToken(userId, orgId)).resolves.toBe(
      "test-device-access:test-oauth-device-client:test-device:test-oauth-device-client:read",
    );

    const stored = await store
      .set(writeDb$)
      .select({
        authMethod: connectors.authMethod,
        oauthScopes: connectors.oauthScopes,
      })
      .from(connectors)
      .where(and(eq(connectors.userId, userId), eq(connectors.orgId, orgId)));
    expect(stored).toStrictEqual([
      { authMethod: "oauth", oauthScopes: JSON.stringify(["read", "granted"]) },
    ]);
    expect((await onlySession(start.body.sessionId)).status).toBe("complete");
  });

  it("completes a session with the stored non-default auth method", async () => {
    const { userId, orgId } = await setupUser();
    const client = setupApp({ context })(
      zeroConnectorOauthDeviceAuthSessionContract,
    );
    const start = await accept(
      client.create({
        params: { type: "test-oauth-device" },
        body: { authMethod: "api" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const response = await accept(
      client.poll({
        params: {
          type: "test-oauth-device",
          sessionId: start.body.sessionId,
        },
        body: { sessionToken: start.body.sessionToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.status).toBe("complete");
    expect(JSON.stringify(response.body)).not.toContain("test-device-access");
    await expect(connectorAccessToken(userId, orgId)).resolves.toBeNull();
    await expect(
      connectorSecretValue(userId, orgId, "TEST_OAUTH_DEVICE_API_ACCESS_TOKEN"),
    ).resolves.toBe(
      "test-device-access:test-oauth-device-api-client:test-device:test-oauth-device-api-client:read",
    );

    const stored = await store
      .set(writeDb$)
      .select({
        authMethod: connectors.authMethod,
        oauthScopes: connectors.oauthScopes,
      })
      .from(connectors)
      .where(and(eq(connectors.userId, userId), eq(connectors.orgId, orgId)));
    expect(stored).toStrictEqual([
      { authMethod: "api", oauthScopes: JSON.stringify(["read"]) },
    ]);
    expect((await onlySession(start.body.sessionId)).status).toBe("complete");
  });

  it.each<{
    readonly caseName: string;
    readonly extraConnectorSecrets: Readonly<Record<string, string>>;
  }>([
    {
      caseName: "primary token",
      extraConnectorSecrets: {
        TEST_OAUTH_DEVICE_ACCESS_TOKEN: "shadow-access-token",
      },
    },
    {
      caseName: "unsupported secret",
      extraConnectorSecrets: {
        TEST_OAUTH_DEVICE_UNDECLARED_SECRET: "undeclared-secret",
      },
    },
  ])(
    "rejects $caseName in extra connector secrets without persisting tokens",
    async ({ extraConnectorSecrets }) => {
      const { userId, orgId } = await setupUser();
      const client = setupApp({ context })(
        zeroConnectorOauthDeviceAuthSessionContract,
      );
      const start = await accept(
        client.create({
          params: { type: "test-oauth-device" },
          body: { authMethod: "oauth" },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      testOauthDeviceProvider.grant.pollDeviceAuth = async (args) => {
        const result = await originalPollDeviceAuth(args);
        if (result.status !== "complete") {
          return result;
        }
        return {
          ...result,
          token: { ...result.token, extraConnectorSecrets },
        };
      };

      const response = await client.poll({
        params: {
          type: "test-oauth-device",
          sessionId: start.body.sessionId,
        },
        body: { sessionToken: start.body.sessionToken },
        headers: { authorization: "Bearer clerk-session" },
      });

      expect(response.status).toBe(500);
      await expect(connectorAccessToken(userId, orgId)).resolves.toBeNull();
      expect((await onlySession(start.body.sessionId)).status).toBe(
        "awaiting_user_authorization",
      );
    },
  );

  it("completes a Base44 session and stores OAuth access and refresh secrets", async () => {
    mockBase44OAuthProvider();
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    users.push({ userId, orgId });
    mocks.clerk.session(userId, orgId);
    const client = setupApp({ context })(
      zeroConnectorOauthDeviceAuthSessionContract,
    );

    const start = await accept(
      client.create({
        params: { type: "base44" },
        body: { authMethod: "oauth" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(start.body).toMatchObject({
      type: "base44",
      status: "pending",
      userCode: "BASE-44",
      verificationUri: "https://app.base44.com/device",
      verificationUriComplete:
        "https://app.base44.com/device?user_code=BASE-44",
      expiresIn: 600,
      interval: 0,
    });
    expect(JSON.stringify(start.body)).not.toContain("base44-device-code");

    const response = await accept(
      client.poll({
        params: {
          type: "base44",
          sessionId: start.body.sessionId,
        },
        body: { sessionToken: start.body.sessionToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.status).toBe("complete");
    expect(JSON.stringify(response.body)).not.toContain("base44-access-token");
    expect(JSON.stringify(response.body)).not.toContain("base44-refresh-token");
    await expect(
      connectorSecretValue(userId, orgId, "BASE44_ACCESS_TOKEN"),
    ).resolves.toBe("base44-access-token");
    await expect(
      connectorSecretValue(userId, orgId, "BASE44_REFRESH_TOKEN"),
    ).resolves.toBe("base44-refresh-token");

    const stored = await store
      .set(writeDb$)
      .select({
        authMethod: connectors.authMethod,
        externalId: connectors.externalId,
        externalUsername: connectors.externalUsername,
        externalEmail: connectors.externalEmail,
        oauthScopes: connectors.oauthScopes,
      })
      .from(connectors)
      .where(
        and(
          eq(connectors.userId, userId),
          eq(connectors.orgId, orgId),
          eq(connectors.type, "base44"),
        ),
      );
    expect(stored).toStrictEqual([
      {
        authMethod: "oauth",
        externalId: "base44-user-id",
        externalUsername: "Base44 User",
        externalEmail: "base44@example.com",
        oauthScopes: JSON.stringify(["apps:read", "apps:write", "offline"]),
      },
    ]);
  });

  it("completes a Slock session and stores OAuth tokens plus server id", async () => {
    const slockTokens = mockSlockOAuthProvider();
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    users.push({ userId, orgId });
    mocks.clerk.session(userId, orgId);
    const client = setupApp({ context })(
      zeroConnectorOauthDeviceAuthSessionContract,
    );

    const start = await accept(
      client.create({
        params: { type: "slock" },
        body: { authMethod: "oauth" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(start.body).toMatchObject({
      type: "slock",
      status: "pending",
      userCode: "SLOCK-1",
      verificationUri: "https://api.slock.ai/device",
      expiresIn: 600,
      interval: 0,
    });
    expect(JSON.stringify(start.body)).not.toContain("slock-device-code");

    const response = await accept(
      client.poll({
        params: {
          type: "slock",
          sessionId: start.body.sessionId,
        },
        body: { sessionToken: start.body.sessionToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.status).toBe("complete");
    expect(JSON.stringify(response.body)).not.toContain(
      slockTokens.accessToken,
    );
    expect(JSON.stringify(response.body)).not.toContain("slock-refresh-token");
    await expect(
      connectorSecretValue(userId, orgId, "SLOCK_ACCESS_TOKEN"),
    ).resolves.toBe(slockTokens.accessToken);
    await expect(
      connectorSecretValue(userId, orgId, "SLOCK_REFRESH_TOKEN"),
    ).resolves.toBe("slock-refresh-token");
    await expect(
      connectorSecretValue(userId, orgId, "SLOCK_SERVER_ID"),
    ).resolves.toBe("slock-server-id");

    const stored = await store
      .set(writeDb$)
      .select({
        authMethod: connectors.authMethod,
        externalId: connectors.externalId,
        externalUsername: connectors.externalUsername,
        externalEmail: connectors.externalEmail,
        oauthScopes: connectors.oauthScopes,
        tokenExpiresAt: connectors.tokenExpiresAt,
      })
      .from(connectors)
      .where(
        and(
          eq(connectors.userId, userId),
          eq(connectors.orgId, orgId),
          eq(connectors.type, "slock"),
        ),
      );
    expect(stored).toStrictEqual([
      {
        authMethod: "oauth",
        externalId: "slock-user-id",
        externalUsername: "Slock User",
        externalEmail: "slock@example.com",
        oauthScopes: JSON.stringify([]),
        tokenExpiresAt: expect.any(Date),
      },
    ]);
    const tokenExpiresAt = stored[0]?.tokenExpiresAt;
    if (!tokenExpiresAt) {
      throw new Error("Expected Slock connector token expiry to be stored");
    }
    expect(tokenExpiresAt.getTime()).toBeGreaterThan(
      nowDate().getTime() + 850_000,
    );
    expect(tokenExpiresAt.getTime()).toBeLessThanOrEqual(
      nowDate().getTime() + SLOCK_ACCESS_TOKEN_TTL_SECONDS * 1000,
    );
  });

  it("marks Slock post-token lookup failures as terminal errors", async () => {
    mockSlockOAuthProvider();
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    users.push({ userId, orgId });
    mocks.clerk.session(userId, orgId);
    const session = await createSession({
      userId,
      orgId,
      connectorType: "slock",
      deviceCode: "userinfo-error",
    });
    const client = setupApp({ context })(
      zeroConnectorOauthDeviceAuthSessionContract,
    );

    const response = await accept(
      client.poll({
        params: { type: "slock", sessionId: session.id },
        body: { sessionToken: session.sessionToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      status: "error",
      errorCode: "post_token_lookup_failed",
      errorMessage:
        "Unable to load Slock account metadata after authorization.",
    });
    await expect(onlySession(session.id)).resolves.toMatchObject({
      status: "error",
      errorCode: "post_token_lookup_failed",
      errorMessage:
        "Unable to load Slock account metadata after authorization.",
    });
    await expect(
      connectorSecretValue(userId, orgId, "SLOCK_ACCESS_TOKEN"),
    ).resolves.toBeNull();
  });

  it("returns terminal denied, expired, and error states", async () => {
    const { userId, orgId } = await setupUser();
    const client = setupApp({ context })(
      zeroConnectorOauthDeviceAuthSessionContract,
    );
    const cases = [
      {
        deviceCode: "denied",
        expected: {
          status: "denied",
          errorCode: "access_denied",
          errorMessage: "User denied the device authorization request",
        },
      },
      {
        deviceCode: "expired",
        expected: {
          status: "expired",
          errorCode: "expired_token",
          errorMessage: "Device authorization expired",
        },
      },
      {
        deviceCode: "error",
        expected: {
          status: "error",
          errorCode: "invalid_request",
          errorMessage: "Synthetic device authorization error",
        },
      },
      {
        deviceCode: "not-issued",
        expected: {
          status: "error",
          errorCode: "invalid_grant",
          errorMessage: "Unknown device authorization code",
        },
      },
    ] as const;

    for (const testCase of cases) {
      const session = await createSession({
        userId,
        orgId,
        deviceCode: testCase.deviceCode,
      });
      const response = await accept(
        client.poll({
          params: { type: "test-oauth-device", sessionId: session.id },
          body: { sessionToken: session.sessionToken },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );

      expect(response.body).toStrictEqual(testCase.expected);
      expect((await onlySession(session.id)).status).toBe(
        testCase.expected.status,
      );
    }
  });

  it("does not poll the provider before the persisted interval elapses", async () => {
    const { userId, orgId } = await setupUser();
    const session = await createSession({
      userId,
      orgId,
      deviceCode: "test-device:test-oauth-device-client:read",
      updatedAt: nowDate(),
    });
    const client = setupApp({ context })(
      zeroConnectorOauthDeviceAuthSessionContract,
    );
    let pollCount = 0;
    testOauthDeviceProvider.grant.pollDeviceAuth = () => {
      pollCount += 1;
      return originalPollDeviceAuth({
        authClient: {
          clientRegistration: "static",
          clientType: "public",
          clientId: "test-oauth-device-client",
        },
        deviceAuthGrant: getConnectorAuthMethodDeviceAuthGrantConfig(
          "test-oauth-device",
          "oauth",
        ),
        deviceCode: "test-device:test-oauth-device-client:read",
      });
    };

    const response = await accept(
      client.poll({
        params: { type: "test-oauth-device", sessionId: session.id },
        body: { sessionToken: session.sessionToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ status: "pending", interval: 5 });
    expect(pollCount).toBe(0);
    expect((await onlySession(session.id)).status).toBe(
      "awaiting_user_authorization",
    );
  });

  it("rejects an invalid session token", async () => {
    const { userId, orgId } = await setupUser();
    const session = await createSession({
      userId,
      orgId,
      deviceCode: "pending",
    });
    const client = setupApp({ context })(
      zeroConnectorOauthDeviceAuthSessionContract,
    );

    const response = await accept(
      client.poll({
        params: { type: "test-oauth-device", sessionId: session.id },
        body: { sessionToken: "wrong-token" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body.error.message).toBe(
      "OAuth device authorization session not found",
    );
  });

  it("does not call the provider twice for concurrent polls", async () => {
    const { userId, orgId } = await setupUser();
    const session = await createSession({
      userId,
      orgId,
      deviceCode: "pending",
    });
    const client = setupApp({ context })(
      zeroConnectorOauthDeviceAuthSessionContract,
    );
    let pollCount = 0;
    let releaseProviderPoll: (() => void) | undefined;
    const providerPollStarted = new Promise<void>((resolve) => {
      testOauthDeviceProvider.grant.pollDeviceAuth = async () => {
        pollCount += 1;
        resolve();
        await new Promise<void>((resolve) => {
          releaseProviderPoll = resolve;
        });
        return { status: "pending" };
      };
    });

    const firstPoll = client.poll({
      params: { type: "test-oauth-device", sessionId: session.id },
      body: { sessionToken: session.sessionToken },
      headers: { authorization: "Bearer clerk-session" },
    });
    await providerPollStarted;

    const secondPoll = await accept(
      client.poll({
        params: { type: "test-oauth-device", sessionId: session.id },
        body: { sessionToken: session.sessionToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(secondPoll.body).toStrictEqual({ status: "pending", interval: 5 });
    expect(pollCount).toBe(1);

    releaseProviderPoll?.();
    const firstResponse = await accept(firstPoll, [200]);
    expect(firstResponse.body).toStrictEqual({
      status: "pending",
      interval: 5,
    });
    expect(pollCount).toBe(1);
  });

  it("does not expire a session while another runner owns a fresh polling claim", async () => {
    const { userId, orgId } = await setupUser();
    const now = nowDate();
    const session = await createSession({
      userId,
      orgId,
      deviceCode: "pending",
      status: "polling",
      updatedAt: now,
      expiresAt: new Date(now.getTime() - 1000),
    });
    const client = setupApp({ context })(
      zeroConnectorOauthDeviceAuthSessionContract,
    );
    let pollCount = 0;
    testOauthDeviceProvider.grant.pollDeviceAuth = () => {
      pollCount += 1;
      return Promise.resolve({ status: "pending" });
    };

    const response = await accept(
      client.poll({
        params: { type: "test-oauth-device", sessionId: session.id },
        body: { sessionToken: session.sessionToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ status: "pending", interval: 5 });
    expect(pollCount).toBe(0);
    expect((await onlySession(session.id)).status).toBe("polling");
  });

  it("returns terminal completion idempotently without polling the provider again", async () => {
    const { userId, orgId } = await setupUser();
    const session = await createSession({
      userId,
      orgId,
      deviceCode: "test-device:test-oauth-device-client:read",
    });
    const client = setupApp({ context })(
      zeroConnectorOauthDeviceAuthSessionContract,
    );

    const first = await accept(
      client.poll({
        params: { type: "test-oauth-device", sessionId: session.id },
        body: { sessionToken: session.sessionToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(first.body.status).toBe("complete");

    testOauthDeviceProvider.grant.pollDeviceAuth = () => {
      return Promise.reject(
        new Error("Provider should not be called for terminal sessions"),
      );
    };

    const second = await accept(
      client.poll({
        params: { type: "test-oauth-device", sessionId: session.id },
        body: { sessionToken: session.sessionToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(second.body.status).toBe("complete");
  });

  it("reclaims stale polling sessions", async () => {
    const { userId, orgId } = await setupUser();
    const session = await createSession({
      userId,
      orgId,
      deviceCode: "pending",
      status: "polling",
      updatedAt: new Date(nowDate().getTime() - 60_000),
    });
    const client = setupApp({ context })(
      zeroConnectorOauthDeviceAuthSessionContract,
    );

    const response = await accept(
      client.poll({
        params: { type: "test-oauth-device", sessionId: session.id },
        body: { sessionToken: session.sessionToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ status: "pending", interval: 5 });
    expect((await onlySession(session.id)).status).toBe(
      "awaiting_user_authorization",
    );
  });
});
