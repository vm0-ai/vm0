import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();

function client() {
  return setupApp({ context })(zeroFeatureSwitchesContract);
}

describe("/api/zero/feature-switches", () => {
  it("ignores unregistered feature switch keys", async () => {
    createZeroRouteMocks(context).clerk.session(
      "user_removed_feature_switch_test",
      "org_removed_feature_switch_test",
      "org:member",
    );
    const headers = { authorization: "Bearer clerk-session" };

    const updated = await accept(
      client().update({
        headers,
        body: {
          switches: {
            removedFeature: true,
          },
        },
      }),
      [200],
    );

    expect(updated.body.switches).not.toHaveProperty("removedFeature");
    expect(updated.body.effectiveSwitches).not.toHaveProperty("removedFeature");

    const current = await accept(client().get({ headers }), [200]);
    expect(current.body.switches).not.toHaveProperty("removedFeature");
    expect(current.body.effectiveSwitches).not.toHaveProperty("removedFeature");
  });

  it("does not persist or activate inline templates for a non-staff org", async () => {
    createZeroRouteMocks(context).clerk.session(
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
            [FeatureSwitchKey.StructuredPromptInlineTemplates]: true,
          },
        },
      }),
      [200],
    );

    expect(updated.body.switches).toStrictEqual({});
    expect(
      updated.body.effectiveSwitches[
        FeatureSwitchKey.StructuredPromptInlineTemplates
      ],
    ).toBeFalsy();

    const current = await accept(client().get({ headers }), [200]);
    expect(current.body.switches).toStrictEqual({});
    expect(
      current.body.effectiveSwitches[
        FeatureSwitchKey.StructuredPromptInlineTemplates
      ],
    ).toBeFalsy();
  });
});
