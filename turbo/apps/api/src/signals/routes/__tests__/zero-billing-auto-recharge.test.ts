import { randomUUID } from "node:crypto";

import { zeroBillingAutoRechargeContract } from "@vm0/api-contracts/contracts/zero-billing";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  deleteAutoRechargeOrg$,
  seedAutoRechargeOrg$,
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
    return store.set(deleteAutoRechargeOrg$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroBillingAutoRechargeContract);

    const response = await accept(client.get({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns the org auto-recharge config from the api implementation", async () => {
    const fixture = await track(
      store.set(
        seedAutoRechargeOrg$,
        {
          enabled: true,
          threshold: 2000,
          amount: 10_000,
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroBillingAutoRechargeContract);

    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      enabled: true,
      threshold: 2000,
      amount: 10_000,
    });
  });

  it("returns the legacy default when the org metadata row does not exist", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

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
