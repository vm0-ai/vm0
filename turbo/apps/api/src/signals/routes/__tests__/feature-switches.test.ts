import { randomUUID } from "node:crypto";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createRouteMocks } from "./helpers/route-test";
import { featureSwitchesRoutes } from "../feature-switches";

const context = testContext();

function client() {
  return setupApp({ context, routes: featureSwitchesRoutes })(
    featureSwitchesContract,
  );
}

describe("/api/feature-switches", () => {
  it("defaults the compact model menu to Bingjie without enabling other staff users", async () => {
    const clerk = createRouteMocks(context).clerk;
    const headers = { authorization: "Bearer clerk-session" };
    clerk.session(
      "user_3EWY21Oe3f15kfs3yYmbGgDb3NV",
      `org_${randomUUID()}`,
      "org:member",
    );
    const owner = await accept(client().get({ headers }), [200]);
    expect(
      owner.body.effectiveSwitches[FeatureSwitchKey.ModelPickerMenu],
    ).toBeTruthy();

    clerk.session(
      `user_${randomUUID()}`,
      "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
      "org:member",
    );
    const staff = await accept(client().get({ headers }), [200]);
    expect(
      staff.body.effectiveSwitches[FeatureSwitchKey.ModelPickerMenu],
    ).toBeFalsy();
  });

  it("persists and activates a user override for a non-staff org", async () => {
    createRouteMocks(context).clerk.session(
      "user_nonstaff_feature_switch_test",
      "org_nonstaff_feature_switch_test",
      "org:member",
    );
    const headers = { authorization: "Bearer clerk-session" };

    const updated = await accept(
      client().update({
        headers,
        body: {
          switches: {
            [FeatureSwitchKey.Dummy]: true,
          },
        },
      }),
      [200],
    );

    expect(updated.body.switches).toStrictEqual({
      [FeatureSwitchKey.Dummy]: true,
    });
    expect(updated.body.effectiveSwitches[FeatureSwitchKey.Dummy]).toBeTruthy();

    const current = await accept(client().get({ headers }), [200]);
    expect(current.body.switches).toStrictEqual({
      [FeatureSwitchKey.Dummy]: true,
    });
    expect(current.body.effectiveSwitches[FeatureSwitchKey.Dummy]).toBeTruthy();
  });
});
