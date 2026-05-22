import { createHash, randomUUID } from "node:crypto";

import { zeroConnectorOauthDeviceAuthSessionContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { CONNECTOR_OAUTH_PROVIDERS } from "@vm0/connectors/oauth-providers";
import { connectors } from "@vm0/db/schema/connector";
import { connectorOauthDeviceAuthorizationSessions } from "@vm0/db/schema/connector-oauth-device-authorization-session";
import { secrets } from "@vm0/db/schema/secret";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import {
  decryptSecretValue,
  encryptSecretValue,
} from "../../services/crypto.utils";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const testOauthDeviceProvider = CONNECTOR_OAUTH_PROVIDERS["test-oauth-device"];
const originalPollDeviceAuth = testOauthDeviceProvider.pollDeviceAuth;
const TEST_OAUTH_DEVICE_CODE_URL =
  "http://localhost:3000/api/test/oauth-provider/device/code";
const TEST_OAUTH_TOKEN_URL =
  "http://localhost:3000/api/test/oauth-provider/token";
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

function sessionTokenHash(sessionToken: string): string {
  return createHash("sha256").update(sessionToken).digest("hex");
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

function encryptedProviderState(deviceCode: string): string {
  return encryptSecretValue(
    JSON.stringify({
      connectorType: "test-oauth-device",
      deviceCode,
    }),
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
      if (!deviceCode?.startsWith("test-device:test-oauth-device-client:")) {
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

async function createSession(args: {
  readonly userId: string;
  readonly orgId: string;
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
      connectorType: "test-oauth-device",
      status: args.status ?? "awaiting_user_authorization",
      sessionTokenHash: sessionTokenHash(sessionToken),
      encryptedProviderState: encryptedProviderState(args.deviceCode),
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
  const [secret] = await store
    .set(writeDb$)
    .select({ encryptedValue: secrets.encryptedValue })
    .from(secrets)
    .where(
      and(
        eq(secrets.orgId, orgId),
        eq(secrets.userId, userId),
        eq(secrets.name, "TEST_OAUTH_DEVICE_ACCESS_TOKEN"),
      ),
    );
  return secret ? decryptSecretValue(secret.encryptedValue) : null;
}

describe("OAuth device authorization connector routes", () => {
  const users: { readonly userId: string; readonly orgId: string }[] = [];

  afterEach(async () => {
    testOauthDeviceProvider.pollDeviceAuth = originalPollDeviceAuth;
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
    const client = setupApp({ context })(
      zeroConnectorOauthDeviceAuthSessionContract,
    );

    const response = await accept(
      client.create({
        params: { type: "test-oauth-device" },
        body: {},
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
    expect(session.status).toBe("awaiting_user_authorization");
    expect(session.sessionTokenHash).toBe(
      sessionTokenHash(response.body.sessionToken),
    );
    expect(session.encryptedProviderState).not.toContain("test-device:");
    expect(decryptSecretValue(session.encryptedProviderState)).toContain(
      "test-device:test-oauth-device-client:read",
    );
    expect(decryptSecretValue(session.encryptedProviderState)).not.toContain(
      "scopes",
    );
  });

  it("marks the previous active session as superseded when a new session starts", async () => {
    const { userId, orgId } = await setupUser();
    const client = setupApp({ context })(
      zeroConnectorOauthDeviceAuthSessionContract,
    );

    const first = await accept(
      client.create({
        params: { type: "test-oauth-device" },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const second = await accept(
      client.create({
        params: { type: "test-oauth-device" },
        body: {},
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

  it("does not persist a superseded session that completes after a new session starts", async () => {
    const { userId, orgId } = await setupUser();
    const client = setupApp({ context })(
      zeroConnectorOauthDeviceAuthSessionContract,
    );
    const first = await accept(
      client.create({
        params: { type: "test-oauth-device" },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    await makeSessionPollable(first.body.sessionId);

    let releaseProviderPoll: (() => void) | undefined;
    const providerPollStarted = new Promise<void>((resolve) => {
      testOauthDeviceProvider.pollDeviceAuth = async (args) => {
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
        body: {},
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

  it("rejects authorization-code OAuth connectors", async () => {
    await setupUser();
    const client = setupApp({ context })(
      zeroConnectorOauthDeviceAuthSessionContract,
    );

    const response = await accept(
      client.create({
        params: { type: "github" },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body.error.message).toBe(
      "github connector does not support OAuth device authorization",
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
        body: {},
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

  it("completes a session through OAuth connector persistence without leaking tokens", async () => {
    const { userId, orgId } = await setupUser();
    const client = setupApp({ context })(
      zeroConnectorOauthDeviceAuthSessionContract,
    );
    const start = await accept(
      client.create({
        params: { type: "test-oauth-device" },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    testOauthDeviceProvider.pollDeviceAuth = async (args) => {
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
    testOauthDeviceProvider.pollDeviceAuth = () => {
      pollCount += 1;
      return originalPollDeviceAuth({
        clientId: "test-oauth-device-client",
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
      testOauthDeviceProvider.pollDeviceAuth = async () => {
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
    testOauthDeviceProvider.pollDeviceAuth = () => {
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

    testOauthDeviceProvider.pollDeviceAuth = () => {
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
