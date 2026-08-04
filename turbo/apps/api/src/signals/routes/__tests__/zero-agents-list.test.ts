import { randomUUID } from "node:crypto";

import { zeroAgentsMainContract } from "@vm0/api-contracts/contracts/zero-agents";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

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
  return setupApp({ context })(zeroAgentsMainContract);
}

describe("GET /api/zero/agents", () => {
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

  it("returns an agent created through POST /api/zero/agents", async () => {
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
});
