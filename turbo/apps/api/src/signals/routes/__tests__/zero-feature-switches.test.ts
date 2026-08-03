import { randomUUID } from "node:crypto";

import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const STAFF_ORG_ID = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";

function client() {
  return setupApp({ context })(zeroFeatureSwitchesContract);
}

describe("/api/zero/feature-switches", () => {
  it("defaults mail reply follow-up to staff and accepts user overrides", async () => {
    const mocks = createZeroRouteMocks(context);
    const headers = { authorization: "Bearer clerk-session" };
    const nonStaffUserId = `user_${randomUUID()}`;
    const nonStaffOrgId = `org_${randomUUID()}`;
    mockOptionalEnv("ZERO_MAIL_REPLY_FOLLOW_UP_ROLLOUT_ENABLED", "true");

    mocks.clerk.session("user_staff_feature_switch_test", STAFF_ORG_ID);
    const staff = await accept(client().get({ headers }), [200]);
    expect(
      staff.body.effectiveSwitches[FeatureSwitchKey.ZeroMailReplyFollowUp],
    ).toBeTruthy();

    mocks.clerk.session(nonStaffUserId, nonStaffOrgId);
    const nonStaff = await accept(client().get({ headers }), [200]);
    expect(
      nonStaff.body.effectiveSwitches[FeatureSwitchKey.ZeroMailReplyFollowUp],
    ).toBeFalsy();

    const overridden = await accept(
      client().update({
        headers,
        body: {
          switches: {
            [FeatureSwitchKey.ZeroMailReplyFollowUp]: true,
          },
        },
      }),
      [200],
    );
    expect(
      overridden.body.switches[FeatureSwitchKey.ZeroMailReplyFollowUp],
    ).toBeTruthy();
    expect(
      overridden.body.effectiveSwitches[FeatureSwitchKey.ZeroMailReplyFollowUp],
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
