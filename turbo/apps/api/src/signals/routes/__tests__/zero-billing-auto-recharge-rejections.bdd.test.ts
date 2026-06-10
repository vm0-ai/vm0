import { randomUUID } from "node:crypto";

import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the auto-recharge read default + the route-level
// update rejections (auth + admin role). An org with no metadata row reads the
// legacy default config. The body/threshold/amount validation runs inside the
// billing service *after* the tier is resolved from seeded org metadata, so
// those cases — and the funded enable/disable/trigger toggles — stay in the kept
// legacy (GAP-ORG-TIER). See `api.bdd.md`
// (CHAIN-BILLING-AUTO-RECHARGE-REJECTIONS).
const context = testContext();

describe("billing auto-recharge default + rejections (API-first BDD)", () => {
  it("reads the legacy default and rejects unauthenticated/org-less reads", async () => {
    const api = createBddApi(context);

    await accept(api.billingAutoRecharge.get({ headers: {} }), [401]);

    api.actAsNoOrg();
    await accept(api.billingAutoRecharge.get({ headers: SESSION_AUTH }), [401]);

    // An org with no metadata row reads the legacy default.
    api.actAsAdmin();
    const def = await accept(
      api.billingAutoRecharge.get({ headers: SESSION_AUTH }),
      [200],
    );
    expect(def.body).toStrictEqual({
      enabled: false,
      threshold: null,
      amount: null,
    });
  });

  it("rejects unauthenticated and non-admin updates before any billing work", async () => {
    const api = createBddApi(context);

    // Unauthenticated.
    await accept(
      api.billingAutoRecharge.update({
        headers: {},
        body: { enabled: true, threshold: 1000, amount: 5000 },
      }),
      [401],
    );

    // Non-admin member (rejected by the route's role check, before any
    // tier/threshold validation in the billing service).
    api.actAsMember({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    });
    const member = await accept(
      api.billingAutoRecharge.update({
        headers: SESSION_AUTH,
        body: { enabled: true, threshold: 1000, amount: 5000 },
      }),
      [403],
    );
    expect(member.body.error.message).toBe(
      "Only org admins can update auto-recharge settings",
    );
  });
});
