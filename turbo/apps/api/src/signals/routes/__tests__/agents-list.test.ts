import { randomUUID } from "node:crypto";

import { agentsMainContract } from "@okouai/api-contracts/contracts/agents";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { materializeAgentLegacyVersionFixture } from "../../../test-fixtures/agent-compose-provenance";
import { overrideCanonicalAgentAuthorityFixture } from "../../../test-fixtures/canonical-agent-authority";
import { createRouteMocks } from "./helpers/route-test";
import { agentsRoutes } from "../agents";

const context = testContext();
const mocks = createRouteMocks(context);

interface OrgUser {
  readonly orgId: string;
  readonly userId: string;
}

function newOrgUser(): OrgUser {
  return { orgId: `org_${randomUUID()}`, userId: `user_${randomUUID()}` };
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function apiClient() {
  return setupApp({ context, routes: agentsRoutes })(agentsMainContract);
}

describe("GET /api/agents", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(apiClient().list({ headers: {} }), [401]);
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const response = await accept(
      apiClient().list({ headers: authHeaders() }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns empty array when no agents exist", async () => {
    const user = newOrgUser();
    mocks.clerk.session(user.userId, user.orgId);

    const response = await accept(
      apiClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual([]);
  });

  it("returns an agent created through POST /api/agents", async () => {
    const user = newOrgUser();
    mocks.clerk.session(user.userId, user.orgId);
    context.mocks.s3.send.mockClear();
    context.mocks.s3.send.mockResolvedValue({});

    const created = await accept(
      apiClient().create({
        headers: authHeaders(),
        body: {
          displayName: "Listed Agent",
          description: "desc",
          sound: "friendly",
        },
      }),
      [201],
    );

    const response = await accept(
      apiClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(response.body).toHaveLength(1);
    expect(response.body[0]?.agentId).toBe(created.body.agentId);
    expect(response.body[0]?.ownerId).toBe(user.userId);
    expect(response.body[0]?.displayName).toBe("Listed Agent");
    expect(response.body[0]?.description).toBe("desc");
    expect(response.body[0]?.sound).toBe("friendly");
  });

  it("returns agents only scoped to caller's org", async () => {
    const user = newOrgUser();
    const otherUser = newOrgUser();
    context.mocks.s3.send.mockResolvedValue({});

    mocks.clerk.session(otherUser.userId, otherUser.orgId);
    await accept(
      apiClient().create({
        headers: authHeaders(),
        body: { displayName: "Foreign Agent" },
      }),
      [201],
    );

    mocks.clerk.session(user.userId, user.orgId);
    const response = await accept(
      apiClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual([]);
  });

  it("uses canonical owner, product state, and updated-at ordering when legacy rows differ", async () => {
    const owner = newOrgUser();
    const canonicalOwner = {
      orgId: owner.orgId,
      userId: `user_${randomUUID()}`,
    };
    mocks.clerk.session(owner.userId, owner.orgId);
    context.mocks.s3.send.mockResolvedValue({});

    const first = await accept(
      apiClient().create({
        headers: authHeaders(),
        body: { displayName: "Legacy First Agent" },
      }),
      [201],
    );
    const second = await accept(
      apiClient().create({
        headers: authHeaders(),
        body: { displayName: "Second Agent" },
      }),
      [201],
    );
    await materializeAgentLegacyVersionFixture(first.body.agentId);

    const legacy = await overrideCanonicalAgentAuthorityFixture({
      agentId: first.body.agentId,
      override: {
        owner: canonicalOwner.userId,
        displayName: "Canonical First Agent",
        visibility: "private",
        updatedAt: new Date("2099-01-01T00:00:00.000Z"),
      },
      signal: context.signal,
    });
    expect(legacy).toStrictEqual({
      legacyOwner: owner.userId,
      legacyDisplayName: "Legacy First Agent",
      legacyVisibility: "public",
    });

    const ownerList = await accept(
      apiClient().list({ headers: authHeaders() }),
      [200],
    );
    expect(
      ownerList.body.map((agent) => {
        return agent.agentId;
      }),
    ).toStrictEqual([second.body.agentId]);

    mocks.clerk.session(canonicalOwner.userId, canonicalOwner.orgId);
    const canonicalOwnerList = await accept(
      apiClient().list({ headers: authHeaders() }),
      [200],
    );
    expect(canonicalOwnerList.body).toHaveLength(2);
    expect(canonicalOwnerList.body[0]).toMatchObject({
      agentId: first.body.agentId,
      ownerId: canonicalOwner.userId,
      displayName: "Canonical First Agent",
      visibility: "private",
    });
    expect(canonicalOwnerList.body[1]?.agentId).toBe(second.body.agentId);
  });

  // #28461 moved this contract to its neutral path, which removed both branded
  // registrations. `MIGRATED_BRANDED_PATHS` gives them back for the released
  // CLI and browser builds that still ask for them; this is the executed
  // request that proves they answer, rather than only that they are registered.
  it("still answers the branded paths released callers hold", async () => {
    const user = newOrgUser();
    mocks.clerk.session(user.userId, user.orgId);
    context.mocks.s3.send.mockResolvedValue({});

    const created = await accept(
      apiClient().create({
        headers: authHeaders(),
        body: { displayName: "Branded Path Agent" },
      }),
      [201],
    );

    const rawRequest = setupRawAppRequest({ context, routes: agentsRoutes });
    const statuses: number[] = [];
    for (const brandedPath of ["/api/okou/agents", "/api/zero/agents"]) {
      const branded = await rawRequest(brandedPath, {
        method: "GET",
        headers: authHeaders(),
      });
      statuses.push(branded.status);
      expect(branded.body).toStrictEqual([
        expect.objectContaining({ agentId: created.body.agentId }),
      ]);
    }
    expect(statuses).toStrictEqual([200, 200]);
  });
});
