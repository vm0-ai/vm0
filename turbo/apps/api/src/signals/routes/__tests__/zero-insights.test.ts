import { randomUUID } from "node:crypto";

import { zeroInsightsContract } from "@vm0/api-contracts/contracts/zero-insights";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

interface InsightsFixture {
  readonly orgId: string;
  readonly userId: string;
}

function newInsightsFixture(): InsightsFixture {
  return { orgId: `org_${randomUUID()}`, userId: `user_${randomUUID()}` };
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function apiClient() {
  return setupApp({ context })(zeroInsightsContract);
}

describe("GET /api/zero/insights", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(
      apiClient().get({ query: {}, headers: {} }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const response = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns empty days when no insights exist", async () => {
    const fixture = newInsightsFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );

    expect(response.body.days).toStrictEqual([]);
    expect(response.body.totalCredits).toBe(0);
    expect(response.body.totalRuns).toBe(0);
    expect(response.body.lastUpdated).toBeNull();
  });
});
