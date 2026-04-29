import { randomUUID } from "node:crypto";

import { zeroBillingAutoRechargeContract } from "@vm0/api-contracts/contracts/zero-billing";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockApiShadowCompareRoutes } from "../../context/shadow-compare";
import {
  deleteAutoRechargeOrg,
  seedAutoRechargeOrg,
  type AutoRechargeOrgFixture,
} from "./helpers/zero-billing-auto-recharge";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("GET /api/zero/billing/auto-recharge", () => {
  const track = createFixtureTracker<AutoRechargeOrgFixture>((fixture) => {
    return deleteAutoRechargeOrg(store, fixture);
  });

  it("returns the org auto-recharge config from the api implementation", async () => {
    const fixture = await track(
      seedAutoRechargeOrg(store, {
        enabled: true,
        threshold: 500,
        amount: 5000,
      }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockApiShadowCompareRoutes([zeroBillingAutoRechargeContract.get]);

    const client = setupApp({ context })(zeroBillingAutoRechargeContract);

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
    mocks.clerk.session(userId, orgId);
    mockApiShadowCompareRoutes([zeroBillingAutoRechargeContract.get]);

    const client = setupApp({ context })(zeroBillingAutoRechargeContract);

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
});
