import { randomUUID } from "node:crypto";

import { zeroConnectorsByTypeContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { variables } from "@vm0/db/schema/variable";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { clearMockedEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import { encryptSecretForTests } from "./helpers/encrypt-secret";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
  type OrgMembershipFixture,
} from "./helpers/zero-org-membership";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy
// `zero-connectors-by-type-delete.test.ts`. The 10 legacy
// `it()`s collapse into 3 BDD `it()`s:
// (1) auth + not-found chain (401 unauth → 401 no org →
// 404 no connector state),
// (2) OAuth + GitHub revoke chain (204 deletes connector
// row + 204 revokes GitHub access token before deleting
// + 204 keeps local deletion authoritative when GitHub
// revoke fails),
// (3) secret + variable cascade chain (204 deletes Slock
// connector + token secrets + 204 deletes only the
// matching connector's variables + 204 deletes Atlassian
// API-token secrets + variables + 404 preserves legacy
// user-owned credentials without a connector row + 204
// deletes optional Gitlab API-token secrets + variables).
//
// Service-Level Exception: connector rows + secrets +
// variables are seeded directly via `writeDb$` because no
// public route creates a connector (connectors are
// provisioned by the OAuth callback flow, not the public
// API).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

async function cleanupOrgData(fixture: OrgMembershipFixture): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.delete(connectors).where(eq(connectors.orgId, fixture.orgId));
  await writeDb.delete(secrets).where(eq(secrets.orgId, fixture.orgId));
  await writeDb.delete(variables).where(eq(variables.orgId, fixture.orgId));
  await store.set(deleteOrgMembership$, fixture, context.signal);
}

async function trackFixture(): Promise<OrgMembershipFixture> {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  const fixture = await store.set(
    seedOrgMembership$,
    { orgId, userId },
    context.signal,
  );
  return track(Promise.resolve(fixture));
}

async function seedOAuthConnector(
  fixture: OrgMembershipFixture,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(connectors).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    type: "github",
    authMethod: "oauth",
  });
}

async function seedSlockOAuthConnectorState(
  fixture: OrgMembershipFixture,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(connectors).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    type: "slock",
    authMethod: "oauth",
  });
  await writeDb.insert(secrets).values([
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      name: "SLOCK_ACCESS_TOKEN",
      encryptedValue: "encrypted_slock_access_token",
      type: "connector",
    },
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      name: "SLOCK_REFRESH_TOKEN",
      encryptedValue: "encrypted_slock_refresh_token",
      type: "connector",
    },
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      name: "SLOCK_SERVER_ID",
      encryptedValue: "encrypted_slock_server_id",
      type: "connector",
    },
  ]);
}

async function seedAtlassianApiTokenState(
  fixture: OrgMembershipFixture,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(connectors).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    type: "atlassian",
    authMethod: "api-token",
  });
  await writeDb.insert(secrets).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    name: "ATLASSIAN_TOKEN",
    encryptedValue: "encrypted_atlassian_token",
    type: "connector",
  });
  await writeDb.insert(variables).values([
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      name: "ATLASSIAN_EMAIL",
      value: "test@example.com",
      type: "connector",
    },
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      name: "ATLASSIAN_DOMAIN",
      value: "example",
      type: "connector",
    },
  ]);
}

async function seedGitlabApiTokenState(
  fixture: OrgMembershipFixture,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(connectors).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    type: "gitlab",
    authMethod: "api-token",
  });
  await writeDb.insert(secrets).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    name: "GITLAB_TOKEN",
    encryptedValue: "encrypted_gitlab_token",
    type: "connector",
  });
  await writeDb.insert(variables).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    name: "GITLAB_HOST",
    value: "gitlab.example.com",
    type: "connector",
  });
}

async function seedLegacyAtlassianUserCredentialState(
  fixture: OrgMembershipFixture,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(secrets).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    name: "ATLASSIAN_TOKEN",
    encryptedValue: "encrypted_atlassian_token",
    type: "user",
  });
  await writeDb.insert(variables).values([
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      name: "ATLASSIAN_EMAIL",
      value: "test@example.com",
      type: "user",
    },
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      name: "ATLASSIAN_DOMAIN",
      value: "example",
      type: "user",
    },
  ]);
}

async function remainingConnectorCount(
  fixture: OrgMembershipFixture,
): Promise<number> {
  const writeDb = store.set(writeDb$);
  const rows = await writeDb
    .select({ id: connectors.id })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, fixture.orgId),
        eq(connectors.userId, fixture.userId),
      ),
    );
  return rows.length;
}

async function remainingSecretAndVariableState(
  fixture: OrgMembershipFixture,
): Promise<{ readonly secrets: number; readonly variables: number }> {
  const writeDb = store.set(writeDb$);
  const [secretRows, variableRows] = await Promise.all([
    writeDb
      .select({ id: secrets.id })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, fixture.orgId),
          eq(secrets.userId, fixture.userId),
        ),
      ),
    writeDb
      .select({ id: variables.id })
      .from(variables)
      .where(
        and(
          eq(variables.orgId, fixture.orgId),
          eq(variables.userId, fixture.userId),
        ),
      ),
  ]);
  return { secrets: secretRows.length, variables: variableRows.length };
}

const track = createFixtureTracker<OrgMembershipFixture>(cleanupOrgData);

function client() {
  return setupApp({ context })(zeroConnectorsByTypeContract);
}

describe("BDD DELETE /api/zero/connectors/:type — auth + not-found chain", () => {
  afterEach(() => {
    clearMockedEnv();
  });

  it("gwt-wt-wt: 401 unauth → 401 no org → 404 no connector state", async () => {
    // Given: no auth header.

    // When + Then: 401.
    const noAuth = await accept(
      client().delete({ params: { type: "github" }, headers: {} }),
      [401],
    );
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a Clerk session with no org.

    // When + Then: 401.
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noOrg = await accept(
      client().delete({
        params: { type: "github" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a fixture with no connector state.

    // When + Then: 404 — Connector not found.
    const fixture = await trackFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const notFoundResponse = await accept(
      client().delete({
        params: { type: "github" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(notFoundResponse.body).toStrictEqual({
      error: { message: "Connector not found", code: "NOT_FOUND" },
    });
  });
});

describe("BDD DELETE /api/zero/connectors/:type — OAuth + GitHub revoke chain", () => {
  afterEach(() => {
    clearMockedEnv();
  });

  it("gwt-wt-wt: 204 deletes connector row → 204 revokes GitHub access token before deleting → 204 keeps local deletion authoritative when GitHub revoke fails", async () => {
    // Given: a fixture with a GitHub OAuth connector.

    // When + Then: 204 — the connector row is removed.
    const simpleFixture = await trackFixture();
    await seedOAuthConnector(simpleFixture);
    mocks.clerk.session(simpleFixture.userId, simpleFixture.orgId);
    const simpleResponse = await accept(
      client().delete({
        params: { type: "github" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );
    expect(simpleResponse.body).toBeUndefined();
    await expect(remainingConnectorCount(simpleFixture)).resolves.toBe(0);

    // Given: a fixture with a GitHub OAuth connector +
    // a GITHUB_ACCESS_TOKEN secret +
    // GH_OAUTH_CLIENT_ID/SECRET env set + a GitHub
    // revoke endpoint that captures the request body.

    // When + Then: 204 — the revoke endpoint receives
    // { access_token: <decrypted> } + the connector +
    // secret are removed.
    const revokeFixture = await trackFixture();
    const revokeWriteDb = store.set(writeDb$);
    await revokeWriteDb.insert(connectors).values({
      orgId: revokeFixture.orgId,
      userId: revokeFixture.userId,
      type: "github",
      authMethod: "oauth",
    });
    await revokeWriteDb.insert(secrets).values({
      orgId: revokeFixture.orgId,
      userId: revokeFixture.userId,
      name: "GITHUB_ACCESS_TOKEN",
      encryptedValue: encryptSecretForTests("gh-revoke-input-token"),
      type: "connector",
    });
    mockOptionalEnv("GH_OAUTH_CLIENT_ID", "test-client-id");
    mockOptionalEnv("GH_OAUTH_CLIENT_SECRET", "test-client-secret");
    let revokeBody = "";
    server.use(
      http.delete(
        "https://api.github.com/applications/test-client-id/grant",
        async ({ request }) => {
          revokeBody = await request.text();
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );
    mocks.clerk.session(revokeFixture.userId, revokeFixture.orgId);
    const revokeResponse = await accept(
      client().delete({
        params: { type: "github" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );
    expect(revokeResponse.body).toBeUndefined();
    expect(revokeBody).toBe(
      JSON.stringify({ access_token: "gh-revoke-input-token" }),
    );
    await expect(remainingConnectorCount(revokeFixture)).resolves.toBe(0);
    await expect(
      remainingSecretAndVariableState(revokeFixture),
    ).resolves.toStrictEqual({
      secrets: 0,
      variables: 0,
    });

    // Given: a fixture with a GitHub OAuth connector +
    // a GITHUB_ACCESS_TOKEN secret +
    // GH_OAUTH_CLIENT_ID/SECRET env set + a GitHub
    // revoke endpoint that returns 500.

    // When + Then: 204 — the local connector + secret
    // are still removed despite the upstream failure.
    const failingFixture = await trackFixture();
    const failingWriteDb = store.set(writeDb$);
    await failingWriteDb.insert(connectors).values({
      orgId: failingFixture.orgId,
      userId: failingFixture.userId,
      type: "github",
      authMethod: "oauth",
    });
    await failingWriteDb.insert(secrets).values({
      orgId: failingFixture.orgId,
      userId: failingFixture.userId,
      name: "GITHUB_ACCESS_TOKEN",
      encryptedValue: encryptSecretForTests("gh-access-token"),
      type: "connector",
    });
    mockOptionalEnv("GH_OAUTH_CLIENT_ID", "test-client-id");
    mockOptionalEnv("GH_OAUTH_CLIENT_SECRET", "test-client-secret");
    server.use(
      http.delete(
        "https://api.github.com/applications/test-client-id/grant",
        () => {
          return HttpResponse.json(
            { error: "forced revoke failure" },
            {
              status: 500,
            },
          );
        },
      ),
    );
    mocks.clerk.session(failingFixture.userId, failingFixture.orgId);
    const failingResponse = await accept(
      client().delete({
        params: { type: "github" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );
    expect(failingResponse.body).toBeUndefined();
    await expect(remainingConnectorCount(failingFixture)).resolves.toBe(0);
    await expect(
      remainingSecretAndVariableState(failingFixture),
    ).resolves.toStrictEqual({
      secrets: 0,
      variables: 0,
    });
  });
});

describe("BDD DELETE /api/zero/connectors/:type — secret + variable cascade chain", () => {
  afterEach(() => {
    clearMockedEnv();
  });

  it("gwt-wt-wt: 204 deletes Slock connector + token secrets → 204 deletes only matching connector's variables → 204 deletes Atlassian API-token secrets + variables → 404 preserves legacy user-owned credentials without a connector row → 204 deletes optional Gitlab API-token secrets + variables", async () => {
    // Given: a fixture with a Slock OAuth connector +
    // 3 Slock connector secrets.

    // When + Then: 204 — connector + all 3 secrets are
    // removed.
    const slockFixture = await trackFixture();
    await seedSlockOAuthConnectorState(slockFixture);
    mocks.clerk.session(slockFixture.userId, slockFixture.orgId);
    const slockResponse = await accept(
      client().delete({
        params: { type: "slock" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );
    expect(slockResponse.body).toBeUndefined();
    await expect(remainingConnectorCount(slockFixture)).resolves.toBe(0);
    await expect(
      remainingSecretAndVariableState(slockFixture),
    ).resolves.toStrictEqual({
      secrets: 0,
      variables: 0,
    });

    // Given: a fixture with an Atlassian connector +
    // 3 connector-owned variables (2 Atlassian, 1
    // Gitlab).

    // When + Then: 204 — only the 2 Atlassian variables
    // are removed, the Gitlab variable remains.
    const variablesFixture = await trackFixture();
    const variablesWriteDb = store.set(writeDb$);
    await variablesWriteDb.insert(connectors).values({
      orgId: variablesFixture.orgId,
      userId: variablesFixture.userId,
      type: "atlassian",
      authMethod: "api-token",
    });
    await variablesWriteDb.insert(variables).values([
      {
        orgId: variablesFixture.orgId,
        userId: variablesFixture.userId,
        name: "ATLASSIAN_EMAIL",
        value: "test@example.com",
        type: "connector",
      },
      {
        orgId: variablesFixture.orgId,
        userId: variablesFixture.userId,
        name: "ATLASSIAN_DOMAIN",
        value: "example",
        type: "connector",
      },
      {
        orgId: variablesFixture.orgId,
        userId: variablesFixture.userId,
        name: "GITLAB_HOST",
        value: "gitlab.example.com",
        type: "connector",
      },
    ]);
    mocks.clerk.session(variablesFixture.userId, variablesFixture.orgId);
    await accept(
      client().delete({
        params: { type: "atlassian" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );
    const remainingVariables = await variablesWriteDb
      .select({
        name: variables.name,
        value: variables.value,
        type: variables.type,
      })
      .from(variables)
      .where(
        and(
          eq(variables.orgId, variablesFixture.orgId),
          eq(variables.userId, variablesFixture.userId),
        ),
      );
    expect(remainingVariables).toStrictEqual([
      {
        name: "GITLAB_HOST",
        value: "gitlab.example.com",
        type: "connector",
      },
    ]);

    // Given: a fixture with an Atlassian API-token
    // connector + 1 secret + 2 variables.

    // When + Then: 204 — secret + variables are
    // removed.
    const atlassianFixture = await trackFixture();
    await seedAtlassianApiTokenState(atlassianFixture);
    mocks.clerk.session(atlassianFixture.userId, atlassianFixture.orgId);
    const atlassianResponse = await accept(
      client().delete({
        params: { type: "atlassian" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );
    expect(atlassianResponse.body).toBeUndefined();
    await expect(
      remainingSecretAndVariableState(atlassianFixture),
    ).resolves.toStrictEqual({
      secrets: 0,
      variables: 0,
    });

    // Given: a fixture with a user-owned legacy
    // Atlassian secret + 2 user-owned variables + no
    // connector row.

    // When + Then: 404 — the connector row is missing
    // + the legacy user-owned credentials remain
    // untouched.
    const legacyFixture = await trackFixture();
    await seedLegacyAtlassianUserCredentialState(legacyFixture);
    mocks.clerk.session(legacyFixture.userId, legacyFixture.orgId);
    const legacyResponse = await accept(
      client().delete({
        params: { type: "atlassian" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(legacyResponse.body).toStrictEqual({
      error: { message: "Connector not found", code: "NOT_FOUND" },
    });
    await expect(
      remainingSecretAndVariableState(legacyFixture),
    ).resolves.toStrictEqual({
      secrets: 1,
      variables: 2,
    });

    // Given: a fixture with a Gitlab API-token
    // connector + 1 secret + 1 optional variable.

    // When + Then: 204 — secret + variable are
    // removed.
    const gitlabFixture = await trackFixture();
    await seedGitlabApiTokenState(gitlabFixture);
    mocks.clerk.session(gitlabFixture.userId, gitlabFixture.orgId);
    const gitlabResponse = await accept(
      client().delete({
        params: { type: "gitlab" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );
    expect(gitlabResponse.body).toBeUndefined();
    await expect(
      remainingSecretAndVariableState(gitlabFixture),
    ).resolves.toStrictEqual({
      secrets: 0,
      variables: 0,
    });
  });
});
