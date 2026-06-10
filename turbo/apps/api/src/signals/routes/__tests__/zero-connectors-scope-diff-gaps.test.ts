import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { zeroConnectorScopeDiffContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { connectors } from "@vm0/db/schema/connector";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const GITHUB_CURRENT_SCOPES = ["repo", "project", "workflow"] as const;

interface Actor {
  readonly orgId: string;
  readonly userId: string;
}

const trackOrg = createFixtureTracker<string>(async (orgId) => {
  const writeDb = store.set(writeDb$);
  await writeDb.delete(connectors).where(eq(connectors.orgId, orgId));
});

function actor(): Actor {
  return {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
}

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function scopeDiffClient() {
  return setupApp({ context })(zeroConnectorScopeDiffContract);
}

function mockSession(member: Actor): void {
  mocks.clerk.session(member.userId, member.orgId);
}

async function insertGithubConnectorWithScopes(args: {
  readonly owner: Actor;
  readonly storedScopes: readonly string[];
}): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(connectors).values({
    userId: args.owner.userId,
    orgId: args.owner.orgId,
    type: "github",
    authMethod: "oauth",
    oauthScopes: JSON.stringify([...args.storedScopes]),
  });
  await trackOrg(Promise.resolve(args.owner.orgId));
}

describe("/api/zero/connectors/:type/scope-diff helper gaps", () => {
  it("returns an empty diff when stored OAuth scopes match current scopes exactly", async () => {
    const owner = actor();
    await insertGithubConnectorWithScopes({
      owner,
      storedScopes: GITHUB_CURRENT_SCOPES,
    });
    mockSession(owner);

    const response = await accept(
      scopeDiffClient().getScopeDiff({
        params: { type: "github" },
        headers: authHeaders(),
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

  it("returns added OAuth scopes when the stored connector is missing required scopes", async () => {
    const owner = actor();
    await insertGithubConnectorWithScopes({
      owner,
      storedScopes: ["repo"],
    });
    mockSession(owner);

    const response = await accept(
      scopeDiffClient().getScopeDiff({
        params: { type: "github" },
        headers: authHeaders(),
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

  it("returns removed OAuth scopes when the stored connector has stale extra scopes", async () => {
    const owner = actor();
    const storedScopes = [...GITHUB_CURRENT_SCOPES, "delete_repo"];
    await insertGithubConnectorWithScopes({
      owner,
      storedScopes,
    });
    mockSession(owner);

    const response = await accept(
      scopeDiffClient().getScopeDiff({
        params: { type: "github" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      addedScopes: [],
      removedScopes: ["delete_repo"],
      currentScopes: GITHUB_CURRENT_SCOPES,
      storedScopes,
    });
  });
});
