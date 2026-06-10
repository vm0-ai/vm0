import { randomUUID } from "node:crypto";

import { zeroConnectorScopeDiffContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { connectors } from "@vm0/db/schema/connector";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { afterEach } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
  type OrgMembershipFixture,
} from "./helpers/zero-org-membership";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

// Mirrors `github.ts` connector OAuth scopes; deterministic so the
// `toStrictEqual` assertions catch any silent payload drift if the
// canonical scope list changes upstream.
const GITHUB_CURRENT_SCOPES = ["repo", "project", "workflow"] as const;

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

async function seedGithubConnector(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly storedScopes: readonly string[];
}): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(connectors).values({
    userId: args.userId,
    orgId: args.orgId,
    type: "github",
    authMethod: "oauth",
    oauthScopes: JSON.stringify([...args.storedScopes]),
  });
}

async function seedStripeApiTokenConnector(args: {
  readonly orgId: string;
  readonly userId: string;
}): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(connectors).values({
    userId: args.userId,
    orgId: args.orgId,
    type: "stripe",
    authMethod: "api-token",
    oauthScopes: null,
  });
}

async function deleteConnectorsByOrg(orgId: string): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.delete(connectors).where(eq(connectors.orgId, orgId));
}

describe("GET /api/zero/connectors/:type/scope-diff", () => {
  const seededFixtures: OrgMembershipFixture[] = [];

  afterEach(async () => {
    while (seededFixtures.length > 0) {
      const fixture = seededFixtures.pop();
      if (fixture) {
        await deleteConnectorsByOrg(fixture.orgId);
        await store.set(deleteOrgMembership$, fixture, context.signal);
      }
    }
  });

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context })(zeroConnectorScopeDiffContract);
    const response = await accept(
      client.getScopeDiff({ params: { type: "github" }, headers: {} }),
      [401],
    );
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const client = setupApp({ context })(zeroConnectorScopeDiffContract);
    const response = await accept(
      client.getScopeDiff({
        params: { type: "github" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 for a sandbox token without connector:read capability", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId,
      orgId,
      runId: `run_${randomUUID()}`,
      capabilities: ["file:read"],
      iat: seconds,
      exp: seconds + 60,
    });
    const client = setupApp({ context })(zeroConnectorScopeDiffContract);
    const response = await accept(
      client.getScopeDiff({
        params: { type: "github" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );
    expect(response.body.error.message).toBe(
      "Missing required capability: connector:read",
    );
  });

  it("returns 404 when no connector is configured for the type", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFixtures.push(
      await store.set(seedOrgMembership$, { orgId, userId }, context.signal),
    );
    mocks.clerk.session(userId, orgId);
    const client = setupApp({ context })(zeroConnectorScopeDiffContract);
    const response = await accept(
      client.getScopeDiff({
        params: { type: "github" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("returns an empty diff when stored scopes match current scopes exactly", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFixtures.push(
      await store.set(seedOrgMembership$, { orgId, userId }, context.signal),
    );
    await seedGithubConnector({
      orgId,
      userId,
      storedScopes: GITHUB_CURRENT_SCOPES,
    });
    mocks.clerk.session(userId, orgId);
    const client = setupApp({ context })(zeroConnectorScopeDiffContract);
    const response = await accept(
      client.getScopeDiff({
        params: { type: "github" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      addedScopes: [],
      removedScopes: [],
      currentScopes: GITHUB_CURRENT_SCOPES,
      storedScopes: GITHUB_CURRENT_SCOPES,
    });
  });

  it("returns an empty diff for selected manual auth methods on mixed connectors", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFixtures.push(
      await store.set(seedOrgMembership$, { orgId, userId }, context.signal),
    );
    await seedStripeApiTokenConnector({ orgId, userId });
    mocks.clerk.session(userId, orgId);
    const client = setupApp({ context })(zeroConnectorScopeDiffContract);
    const response = await accept(
      client.getScopeDiff({
        params: { type: "stripe" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      addedScopes: [],
      removedScopes: [],
      currentScopes: [],
      storedScopes: [],
    });
  });

  it("returns added scopes when the connector is missing required scopes", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFixtures.push(
      await store.set(seedOrgMembership$, { orgId, userId }, context.signal),
    );
    await seedGithubConnector({
      orgId,
      userId,
      storedScopes: ["repo"],
    });
    mocks.clerk.session(userId, orgId);
    const client = setupApp({ context })(zeroConnectorScopeDiffContract);
    const response = await accept(
      client.getScopeDiff({
        params: { type: "github" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      addedScopes: ["project", "workflow"],
      removedScopes: [],
      currentScopes: GITHUB_CURRENT_SCOPES,
      storedScopes: ["repo"],
    });
  });

  it("returns removed scopes when the connector has stale extra scopes", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFixtures.push(
      await store.set(seedOrgMembership$, { orgId, userId }, context.signal),
    );
    const stored = [...GITHUB_CURRENT_SCOPES, "delete_repo"];
    await seedGithubConnector({ orgId, userId, storedScopes: stored });
    mocks.clerk.session(userId, orgId);
    const client = setupApp({ context })(zeroConnectorScopeDiffContract);
    const response = await accept(
      client.getScopeDiff({
        params: { type: "github" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      addedScopes: [],
      removedScopes: ["delete_repo"],
      currentScopes: GITHUB_CURRENT_SCOPES,
      storedScopes: stored,
    });
  });
});
