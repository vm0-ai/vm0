import { randomUUID } from "node:crypto";

import { zeroMemberCreditCapContract } from "@vm0/api-contracts/contracts/zero-member-credit-cap";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function apiClient() {
  return setupApp({ context })(zeroMemberCreditCapContract);
}

describe("GET /api/zero/org/members/credit-cap", () => {
  it("returns 401 for unauthenticated request", async () => {
    const userId = `user_${randomUUID()}`;
    const response = await accept(
      apiClient().get({ query: { userId }, headers: {} }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    const sessionUserId = `user_${randomUUID()}`;
    const targetUserId = `user_${randomUUID()}`;
    mocks.clerk.session(sessionUserId, null);

    const response = await accept(
      apiClient().get({
        query: { userId: targetUserId },
        headers: authHeaders(),
      }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns default cap state (null cap, enabled)", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const response = await accept(
      apiClient().get({ query: { userId }, headers: authHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({
      userId,
      creditCap: null,
      creditEnabled: true,
    });
  });

  it("returns 400 when userId is missing", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const response = await accept(
      apiClient().get({ query: { userId: "" }, headers: authHeaders() }),
      [400],
    );
    expect(response.body.error.code).toBe("BAD_REQUEST");
  });
});
