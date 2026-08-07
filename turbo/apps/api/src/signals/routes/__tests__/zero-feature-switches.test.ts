import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { zeroFeatureSwitchesRoutes } from "../zero-feature-switches";

const context = testContext();
const LEGACY_MAIL_REPLY_FOLLOW_UP_SWITCH = "zeroMailReplyFollowUp";
const LEGACY_CHAT_THREAD_SIDEBAR_AUTO_OPEN_SWITCH = "chatThreadSidebarAutoOpen";

function client() {
  return setupApp({ context, routes: zeroFeatureSwitchesRoutes })(
    zeroFeatureSwitchesContract,
  );
}

describe("/api/zero/feature-switches", () => {
  it("forces the previous Platform Mail follow-up switch off", async () => {
    createZeroRouteMocks(context).clerk.session(
      "user_legacy_mail_follow_up_test",
      "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
      "org:member",
    );
    const response = await accept(
      client().get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const previousPlatformSwitches: Record<string, boolean> = {
      [LEGACY_MAIL_REPLY_FOLLOW_UP_SWITCH]: true,
    };
    for (const key of Object.keys(previousPlatformSwitches)) {
      const value = response.body.effectiveSwitches[key];
      if (value !== undefined) {
        previousPlatformSwitches[key] = value;
      }
    }

    expect(
      response.body.effectiveSwitches[LEGACY_MAIL_REPLY_FOLLOW_UP_SWITCH],
    ).toBeFalsy();
    expect(
      previousPlatformSwitches[LEGACY_MAIL_REPLY_FOLLOW_UP_SWITCH],
    ).toBeFalsy();
  });

  it("keeps sidebar auto-open enabled for previous Platform bundles", async () => {
    createZeroRouteMocks(context).clerk.session(
      "user_legacy_sidebar_auto_open_test",
      "org_legacy_sidebar_auto_open_test",
      "org:member",
    );
    const response = await accept(
      client().get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const previousPlatformSwitches: Record<string, boolean> = {
      [LEGACY_CHAT_THREAD_SIDEBAR_AUTO_OPEN_SWITCH]: false,
    };
    for (const key of Object.keys(previousPlatformSwitches)) {
      const value = response.body.effectiveSwitches[key];
      if (value !== undefined) {
        previousPlatformSwitches[key] = value;
      }
    }

    expect(
      response.body.effectiveSwitches[
        LEGACY_CHAT_THREAD_SIDEBAR_AUTO_OPEN_SWITCH
      ],
    ).toBeTruthy();
    expect(
      previousPlatformSwitches[LEGACY_CHAT_THREAD_SIDEBAR_AUTO_OPEN_SWITCH],
    ).toBeTruthy();
  });

  it("persists and activates a user override for a non-staff org", async () => {
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
            [FeatureSwitchKey.ComposerUploadPopover]: true,
          },
        },
      }),
      [200],
    );

    expect(updated.body.switches).toStrictEqual({
      [FeatureSwitchKey.ComposerUploadPopover]: true,
    });
    expect(
      updated.body.effectiveSwitches[FeatureSwitchKey.ComposerUploadPopover],
    ).toBeTruthy();
    expect(updated.body.supportsImageRecognition).toBeTruthy();
    expect(updated.body.supportsAvatarTemplates).toBeTruthy();

    const current = await accept(client().get({ headers }), [200]);
    expect(current.body.switches).toStrictEqual({
      [FeatureSwitchKey.ComposerUploadPopover]: true,
    });
    expect(current.body.supportsCustomConnectorOAuth2).toBeTruthy();
    expect(current.body.supportsImageRecognition).toBeTruthy();
    expect(current.body.supportsAvatarTemplates).toBeTruthy();
    expect(
      current.body.effectiveSwitches[FeatureSwitchKey.ComposerUploadPopover],
    ).toBeTruthy();
  });
});
