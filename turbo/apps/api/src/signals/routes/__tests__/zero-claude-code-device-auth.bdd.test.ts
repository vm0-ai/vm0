import { randomUUID } from "node:crypto";

import { zeroClaudeCodeDeviceAuthContract } from "@vm0/api-contracts/contracts/zero-claude-code-device-auth";
import { modelProviderAuthSessions } from "@vm0/db/schema/model-provider-auth-session";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { secrets } from "@vm0/db/schema/secret";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { afterEach } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { clearMockedEnv, mockEnv } from "../../../lib/env";
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

// BDD migration of the legacy
// `zero-claude-code-device-auth.test.ts`. The 4 legacy
// `it()`s collapse into 2 BDD `it()`s: (1) start + cancel
// chain (200 start returns setup-token OAuth details + DB row
// created → 200 cancel marks the session cancelled), (2)
// complete chain (200 org-scope complete imports the OAuth
// token via the upstream MSW mock + provider row + secret
// row → 200 personal-scope complete for non-admin member
// writes a user-scoped secret).
//
// Service-Level Exception: the upstream Claude token
// endpoint is mocked via MSW handlers; `modelProviderAuthSessions`
// and `secrets` rows are read directly via `writeDb$` because
// no public route exposes them.

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

function claudeCodeDeviceAuthSessions(userId: string, orgId: string) {
  return store
    .set(writeDb$)
    .select()
    .from(modelProviderAuthSessions)
    .where(
      and(
        eq(modelProviderAuthSessions.userId, userId),
        eq(modelProviderAuthSessions.orgId, orgId),
        eq(modelProviderAuthSessions.connectorType, "claude-code-oauth-token"),
        eq(modelProviderAuthSessions.source, "claude-code-device-auth"),
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
  return secret ? await decryptStoredSecretValue(secret.encryptedValue) : null;
}

function stateFromBrowserUrl(browserUrl: string): string {
  const state = new URL(browserUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Missing state in Claude Code browser URL");
  }
  return state;
}

interface ClaudeCodeAuthFixture {
  readonly userId: string;
  readonly orgId: string;
}

function createClaudeCodeAuthHarness(): {
  readonly setupUser: (
    role?: "org:admin" | "org:member",
  ) => ClaudeCodeAuthFixture;
} {
  const fixtures: ClaudeCodeAuthFixture[] = [];
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

  const setupUser = (
    role: "org:admin" | "org:member" = "org:admin",
  ): ClaudeCodeAuthFixture => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    fixtures.push({ userId, orgId });
    mocks.clerk.session(userId, orgId, role);
    return { userId, orgId };
  };

  return { setupUser };
}

describe("BDD Claude Code device auth — start + cancel chain", () => {
  const { setupUser } = createClaudeCodeAuthHarness();

  it("gwt-wt-wt: 200 start returns setup-token OAuth details + DB row created → 200 cancel marks the session cancelled", async () => {
    // Given: a fresh admin user + KMS wired.
    const { userId, orgId } = setupUser();
    const kms = fakeKmsClient();
    setSecretKmsClientForTests(kms.client);
    mockEnv("SECRETS_KMS_KEY_ID", "alias/vm0-secrets");

    // When: start a Claude Code device auth.
    const started = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { scope: "org" },
      }),
      [200],
    );

    // Then: 200 + browserUrl is the Claude authorize URL +
    // session row exists + provider state is KMS-encrypted.
    expect(started.status).toBe(200);
    expect(started.body.type).toBe("claude-code");
    expect(started.body.scope).toBe("org");
    const browserUrl = new URL(started.body.browserUrl);
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
    expect(isKmsSecretForTests(session!.encryptedProviderState!)).toBeTruthy();
    expect(kms.calls).toHaveLength(1);

    // When: cancel the session.
    const cancelled = await accept(
      client().cancel({
        headers: { authorization: "Bearer clerk-session" },
        body: { sessionToken: started.body.sessionToken },
      }),
      [200],
    );

    // Then: 200 + the session is now cancelled.
    expect(cancelled.status).toBe(200);
    const [afterCancel] = await claudeCodeDeviceAuthSessions(userId, orgId);
    expect(afterCancel?.status).toBe("cancelled");
    expect(afterCancel?.errorMessage).toBe(
      "Claude Code device auth session was cancelled",
    );
  });
});

describe("BDD Claude Code device auth — complete chain", () => {
  const { setupUser } = createClaudeCodeAuthHarness();

  it("gwt-wt-wt: 200 org-scope complete imports the OAuth token via MSW → 200 personal-scope complete for non-admin member writes a user-scoped secret", async () => {
    // Given: a fresh admin user + the upstream Claude token
    // endpoint mocked.
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

    // When: complete with an authorization code.
    const completed = await accept(
      client().complete({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          sessionToken: started.body.sessionToken,
          authorizationCode: `auth_code_test#${state}`,
        },
      }),
      [200],
    );

    // Then: 200 + provider row + secret row at the org scope +
    // upstream token exchange called once.
    expect(completed.status).toBe(200);
    expect(completed.body.status).toBe("complete");
    expect(completed.body.provider.type).toBe("claude-code-oauth-token");
    expect(completed.body.provider.secretName).toBe("CLAUDE_CODE_OAUTH_TOKEN");
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

    // Given: a non-admin member + a fresh personal-scope
    // session.
    const { userId: memberId, orgId: memberOrgId } = setupUser("org:member");
    mockClaudeCodeDeviceAuthHttp();
    const personalStarted = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { scope: "personal" },
      }),
      [200],
    );
    const personalState = stateFromBrowserUrl(personalStarted.body.browserUrl);

    // When: complete with a callback URL.
    const personalCompleted = await accept(
      client().complete({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          sessionToken: personalStarted.body.sessionToken,
          authorizationCode: `https://platform.claude.com/oauth/code/callback?code=member_code&state=${personalState}`,
        },
      }),
      [200],
    );

    // Then: 200 + a user-scoped secret was written.
    expect(personalCompleted.status).toBe(200);
    expect(personalCompleted.body.provider.type).toBe(
      "claude-code-oauth-token",
    );
    await expect(
      claudeCodeSecret({ orgId: memberOrgId, userId: memberId }),
    ).resolves.toBe("claude-code-access-token");
  });
});
