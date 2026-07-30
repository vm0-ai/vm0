import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();

function client() {
  return setupApp({ context })(zeroFeatureSwitchesContract);
}

describe("/api/zero/feature-switches", () => {
  it("projects the Japanese locale deployment switch", async () => {
    createZeroRouteMocks(context).clerk.session(
      "user_japanese_locale_switch_test",
      "org_japanese_locale_switch_test",
      "org:member",
    );
    const headers = { authorization: "Bearer clerk-session" };

    mockOptionalEnv("JAPANESE_LOCALE_ROLLOUT_ENABLED", undefined);
    const disabled = await accept(client().get({ headers }), [200]);
    expect(
      disabled.body.effectiveSwitches[FeatureSwitchKey.JapaneseLocale],
    ).toBeFalsy();

    mockOptionalEnv("JAPANESE_LOCALE_ROLLOUT_ENABLED", "true");
    const enabled = await accept(client().get({ headers }), [200]);
    expect(
      enabled.body.effectiveSwitches[FeatureSwitchKey.JapaneseLocale],
    ).toBeTruthy();
  });

  it("projects the Korean locale deployment switch", async () => {
    createZeroRouteMocks(context).clerk.session(
      "user_korean_locale_switch_test",
      "org_korean_locale_switch_test",
      "org:member",
    );
    const headers = { authorization: "Bearer clerk-session" };

    mockOptionalEnv("KOREAN_LOCALE_ROLLOUT_ENABLED", undefined);
    const disabled = await accept(client().get({ headers }), [200]);
    expect(
      disabled.body.effectiveSwitches[FeatureSwitchKey.KoreanLocale],
    ).toBeFalsy();

    mockOptionalEnv("KOREAN_LOCALE_ROLLOUT_ENABLED", "true");
    const enabled = await accept(client().get({ headers }), [200]);
    expect(
      enabled.body.effectiveSwitches[FeatureSwitchKey.KoreanLocale],
    ).toBeTruthy();
  });

  it("persists and activates inline templates for a non-staff org", async () => {
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

    expect(updated.body.switches).toStrictEqual({
      [FeatureSwitchKey.StructuredPromptInlineTemplates]: true,
    });
    expect(
      updated.body.effectiveSwitches[
        FeatureSwitchKey.StructuredPromptInlineTemplates
      ],
    ).toBeTruthy();

    const current = await accept(client().get({ headers }), [200]);
    expect(current.body.switches).toStrictEqual({
      [FeatureSwitchKey.StructuredPromptInlineTemplates]: true,
    });
    expect(current.body.supportsCustomConnectorOAuth2).toBeTruthy();
    expect(current.body.supportsCustomModelGateways).toBeTruthy();
    expect(
      current.body.effectiveSwitches[
        FeatureSwitchKey.StructuredPromptInlineTemplates
      ],
    ).toBeTruthy();
  });
});
