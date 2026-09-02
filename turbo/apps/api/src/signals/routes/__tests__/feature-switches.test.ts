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
      dummy: true,
    });
    expect(updated.body.effectiveSwitches[FeatureSwitchKey.Dummy]).toBeTruthy();

    const current = await accept(client().get({ headers }), [200]);
    expect(current.body.switches).toStrictEqual({
      [FeatureSwitchKey.Dummy]: true,
      dummy: true,
    });
    expect(current.body.effectiveSwitches[FeatureSwitchKey.Dummy]).toBeTruthy();
  });

  it("accepts legacy keys and returns both rollout representations", async () => {
    createRouteMocks(context).clerk.session(
      "user_legacy_feature_switch_test",
      "org_legacy_feature_switch_test",
      "org:member",
    );
    const headers = { authorization: "Bearer clerk-session" };

    const updated = await accept(
      client().update({
        headers,
        body: {
          switches: {
            personalModelProviderAccounts: true,
            okouDebug: false,
          },
        },
      }),
      [200],
    );

    expect(updated.body.switches).toStrictEqual({
      [FeatureSwitchKey.PersonalModelProviderAccounts]: true,
      personalModelProviderAccounts: true,
      [FeatureSwitchKey.OkouDebug]: false,
      okouDebug: false,
    });
    expect(
      updated.body.effectiveSwitches[
        FeatureSwitchKey.PersonalModelProviderAccounts
      ],
    ).toBeTruthy();

    const current = await accept(client().get({ headers }), [200]);
    expect(current.body.switches).toStrictEqual(updated.body.switches);
  });
});
