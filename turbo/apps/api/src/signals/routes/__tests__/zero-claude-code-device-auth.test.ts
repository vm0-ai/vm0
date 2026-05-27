import { randomUUID } from "node:crypto";

import { zeroClaudeCodeDeviceAuthContract } from "@vm0/api-contracts/contracts/zero-claude-code-device-auth";
import { connectorCliAuthSessions } from "@vm0/db/schema/connector-cli-auth-session";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { secrets } from "@vm0/db/schema/secret";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { clearMockedEnv, mockEnv } from "../../../lib/env";
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
  return setupApp({ context })(zeroClaudeCodeDeviceAuthContract);
}

function mockClaudeCodeDeviceAuthHttp() {
  const calls = {
    token: [] as unknown[],
  };

  server.use(
    http.post(
      "https://platform.claude.com/v1/oauth/token",
      async ({ request }) => {
        calls.token.push(await request.json());
        return HttpResponse.json({
          access_token: "claude-code-access-token",
          expires_in: 31_536_000,
          scope: "user:inference",
        });
      },
    ),
  );

  return calls;
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

function claudeCodeDeviceAuthSessions(userId: string, orgId: string) {
  return store
    .set(writeDb$)
    .select()
    .from(connectorCliAuthSessions)
    .where(
      and(
        eq(connectorCliAuthSessions.userId, userId),
        eq(connectorCliAuthSessions.orgId, orgId),
        eq(connectorCliAuthSessions.connectorType, "claude-code-oauth-token"),
        eq(connectorCliAuthSessions.source, "claude-code-device-auth"),
      ),
    );
}

async function claudeCodeSecret(args: {
  readonly orgId: string;
  readonly userId: string;
}) {
  const [secret] = await store
    .set(writeDb$)
    .select({ encryptedValue: secrets.encryptedValue })
    .from(secrets)
    .where(
      and(
        eq(secrets.orgId, args.orgId),
        eq(secrets.userId, args.userId),
        eq(secrets.name, "CLAUDE_CODE_OAUTH_TOKEN"),
        eq(secrets.type, "model-provider"),
      ),
    )
    .limit(1);
  return secret ? decryptSecretValue(secret.encryptedValue) : null;
}

function stateFromBrowserUrl(browserUrl: string): string {
  const state = new URL(browserUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Missing state in Claude Code browser URL");
  }
  return state;
}

describe("Claude Code device auth routes", () => {
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

  it("starts Claude Code device auth and returns setup-token OAuth details", async () => {
    const { userId, orgId } = setupUser();
    const kms = fakeKmsClient();
    setSecretKmsClientForTests(kms.client);
    mockEnv("SECRETS_KMS_KEY_ID", "alias/vm0-secrets");

    const response = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { scope: "org" },
      }),
      [200],
    );

    expect(response.status).toBe(200);
    expect(response.body.type).toBe("claude-code");
    expect(response.body.scope).toBe("org");
    const browserUrl = new URL(response.body.browserUrl);
    expect(browserUrl.origin + browserUrl.pathname).toBe(
      "https://claude.com/cai/oauth/authorize",
    );
    expect(browserUrl.searchParams.get("code")).toBe("true");
    expect(browserUrl.searchParams.get("client_id")).toBe(
      "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    );
    expect(browserUrl.searchParams.get("redirect_uri")).toBe(
      "https://platform.claude.com/oauth/code/callback",
    );
    expect(browserUrl.searchParams.get("scope")).toBe("user:inference");
    await expect(
      claudeCodeDeviceAuthSessions(userId, orgId),
    ).resolves.toHaveLength(1);
    const [session] = await claudeCodeDeviceAuthSessions(userId, orgId);
    expect(
      inspectPersistentSecretCiphertext(session!.encryptedProviderState!),
    ).toStrictEqual({
      format: "kms",
      hasLegacy: false,
      hasKms: true,
    });
    expect(kms.calls).toHaveLength(1);
  });

  it("cancels pending Claude Code device auth", async () => {
    const { userId, orgId } = setupUser();
    const started = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { scope: "org" },
      }),
      [200],
    );

    const response = await accept(
      client().cancel({
        headers: { authorization: "Bearer clerk-session" },
        body: { sessionToken: started.body.sessionToken },
      }),
      [200],
    );

    expect(response.status).toBe(200);
    const [session] = await claudeCodeDeviceAuthSessions(userId, orgId);
    expect(session?.status).toBe("cancelled");
    expect(session?.errorMessage).toBe(
      "Claude Code device auth session was cancelled",
    );
  });

  it("completes org-scope Claude Code device auth and imports the OAuth token", async () => {
    const { orgId } = setupUser();
    const calls = mockClaudeCodeDeviceAuthHttp();
    const started = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { scope: "org" },
      }),
      [200],
    );
    const state = stateFromBrowserUrl(started.body.browserUrl);

    const response = await accept(
      client().complete({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          sessionToken: started.body.sessionToken,
          authorizationCode: `auth_code_test#${state}`,
        },
      }),
      [200],
    );

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("complete");
    expect(response.body.provider.type).toBe("claude-code-oauth-token");
    expect(response.body.provider.secretName).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    await expect(
      claudeCodeSecret({ orgId, userId: ORG_SENTINEL_USER_ID }),
    ).resolves.toBe("claude-code-access-token");
    expect(calls.token).toMatchObject([
      {
        grant_type: "authorization_code",
        code: "auth_code_test",
        redirect_uri: "https://platform.claude.com/oauth/code/callback",
        client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
        state,
        expires_in: 31_536_000,
      },
    ]);
  });

  it("completes personal-scope Claude Code device auth for non-admin members", async () => {
    const { userId, orgId } = setupUser("org:member");
    mockClaudeCodeDeviceAuthHttp();
    const started = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { scope: "personal" },
      }),
      [200],
    );
    const state = stateFromBrowserUrl(started.body.browserUrl);

    const response = await accept(
      client().complete({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          sessionToken: started.body.sessionToken,
          authorizationCode: `https://platform.claude.com/oauth/code/callback?code=member_code&state=${state}`,
        },
      }),
      [200],
    );

    expect(response.status).toBe(200);
    expect(response.body.provider.type).toBe("claude-code-oauth-token");
    await expect(claudeCodeSecret({ orgId, userId })).resolves.toBe(
      "claude-code-access-token",
    );
  });
});
