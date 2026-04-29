import { randomUUID } from "node:crypto";

import { zeroBillingAutoRechargeContract } from "@vm0/api-contracts/contracts/zero-billing";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { zeroBillingAutoRechargeRoutes } from "../zero-billing-auto-recharge";
import {
  deleteAutoRechargeOrg,
  seedAutoRechargeOrg,
  type AutoRechargeOrgFixture,
} from "./helpers/zero-billing-auto-recharge";

const context = testContext();
const store = createStore();

function mockSession(userId: string, orgId: string | null): void {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: true,
    toAuth: () => {
      return {
        userId,
        orgId,
        orgRole: orgId ? "org:admin" : undefined,
      };
    },
  });
}

describe("GET /api/zero/billing/auto-recharge", () => {
  const fixtures: AutoRechargeOrgFixture[] = [];

  beforeEach(() => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
  });

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await deleteAutoRechargeOrg(store, fixture);
      }
    }
  });

  async function track(
    fixturePromise: Promise<AutoRechargeOrgFixture>,
  ): Promise<AutoRechargeOrgFixture> {
    const fixture = await fixturePromise;
    fixtures.push(fixture);
    return fixture;
  }

  it("returns the org auto-recharge config from the api implementation", async () => {
    const fixture = await track(
      seedAutoRechargeOrg(store, {
        enabled: true,
        threshold: 500,
        amount: 5000,
      }),
    );
    mockSession(fixture.userId, fixture.orgId);

    const client = setupApp({
      context,
      routes: zeroBillingAutoRechargeRoutes("api"),
    })(zeroBillingAutoRechargeContract);

    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      enabled: true,
      threshold: 500,
      amount: 5000,
    });
  });

  it("returns the legacy default when the org metadata row does not exist", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    mockSession(userId, orgId);

    const client = setupApp({
      context,
      routes: zeroBillingAutoRechargeRoutes("api"),
    })(zeroBillingAutoRechargeContract);

    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      enabled: false,
      threshold: null,
      amount: null,
    });
  });

  it("requires authentication", async () => {
    const client = setupApp({
      context,
      routes: zeroBillingAutoRechargeRoutes("api"),
    })(zeroBillingAutoRechargeContract);

    const response = await accept(
      client.get({
        headers: {},
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("requires organization context", async () => {
    mockSession(`user_${randomUUID()}`, null);
    const client = setupApp({
      context,
      routes: zeroBillingAutoRechargeRoutes("api"),
    })(zeroBillingAutoRechargeContract);

    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns web traffic when the shadow source is web", async () => {
    const fixture = await track(
      seedAutoRechargeOrg(store, {
        enabled: true,
        threshold: 500,
        amount: 5000,
      }),
    );
    mockSession(fixture.userId, fixture.orgId);
    mockEnv("VM0_WEB_URL", "https://www.vm0.ai");

    let observedAuth: string | null = null;
    server.use(
      http.get(
        "https://www.vm0.ai/api/zero/billing/auto-recharge",
        ({ request }) => {
          observedAuth = request.headers.get("authorization");
          return HttpResponse.json({
            enabled: false,
            threshold: null,
            amount: null,
          });
        },
      ),
    );

    const client = setupApp({
      context,
      routes: zeroBillingAutoRechargeRoutes("web"),
    })(zeroBillingAutoRechargeContract);

    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      enabled: false,
      threshold: null,
      amount: null,
    });
    expect(observedAuth).toBe("Bearer clerk-session");
  });
});
