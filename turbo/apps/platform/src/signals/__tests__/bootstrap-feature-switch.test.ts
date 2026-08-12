import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { setupPage } from "../../__tests__/page-helper.ts";
import {
  avatarTemplatesEnabled$,
  feedbackLocationApiSupported$,
  featureSwitch$,
  imageRecognitionAvailable$,
} from "../external/feature-switch.ts";
import { testContext } from "./test-helpers.ts";

const context = testContext();

describe("bootstrap feature switch hydration", () => {
  it("hydrates persisted feature switches for authenticated users", async () => {
    context.mocks.api(zeroFeatureSwitchesContract.get, ({ respond }) => {
      return respond(200, {
        switches: { [FeatureSwitchKey.AhrefsConnector]: true },
        effectiveSwitches: { [FeatureSwitchKey.AhrefsConnector]: true },
      });
    });

    await setupPage({
      context,
      path: "/error",
      withoutRender: true,
    });

    expect(
      context.store.get(featureSwitch$)[FeatureSwitchKey.AhrefsConnector],
    ).toBeTruthy();
    expect(context.store.get(feedbackLocationApiSupported$)).toBeFalsy();
  });

  it("enables feedback locations only after the API advertises support", async () => {
    context.mocks.api(zeroFeatureSwitchesContract.get, ({ respond }) => {
      return respond(200, {
        switches: {},
        effectiveSwitches: {},
        apiCapabilities: { feedbackLocationV1: true },
      });
    });

    await setupPage({
      context,
      path: "/error",
      withoutRender: true,
    });

    expect(context.store.get(feedbackLocationApiSupported$)).toBeTruthy();
  });

  it("keeps image recognition available without capability negotiation", async () => {
    context.mocks.api(zeroFeatureSwitchesContract.get, ({ respond }) => {
      return respond(200, {
        switches: {},
        effectiveSwitches: {},
      });
    });

    await setupPage({
      context,
      path: "/error",
      withoutRender: true,
    });

    expect(context.store.get(imageRecognitionAvailable$)).toBeTruthy();
  });

  it("enables avatar templates from the feature switch alone", async () => {
    context.mocks.api(zeroFeatureSwitchesContract.get, ({ respond }) => {
      return respond(200, {
        switches: { [FeatureSwitchKey.JoggAiBuiltIn]: true },
        effectiveSwitches: { [FeatureSwitchKey.JoggAiBuiltIn]: true },
      });
    });

    await setupPage({
      context,
      path: "/error",
      withoutRender: true,
    });

    expect(context.store.get(avatarTemplatesEnabled$)).toBeTruthy();
  });

  it("skips feature switch hydration without an authenticated organization", async () => {
    context.mocks.api(zeroFeatureSwitchesContract.get, ({ respond }) => {
      return respond(500, {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Feature switches must not load while signed out",
        },
      });
    });

    await setupPage({
      context,
      path: "/sign-in",
      user: null,
      session: null,
      org: { activeOrg: null, memberships: [] },
      withoutRender: true,
    });

    expect(
      context.store.get(featureSwitch$)[FeatureSwitchKey.AhrefsConnector],
    ).toBeFalsy();
  });
});
