import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { setupPage } from "../../__tests__/page-helper.ts";
import {
  featureSwitch$,
  imageRecognitionAvailable$,
} from "../external/feature-switch.ts";
import { testContext } from "./test-helpers.ts";

const context = testContext();

describe("bootstrap feature switch hydration", () => {
  it("hydrates persisted feature switches for authenticated users", async () => {
    context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
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
  });

  it("keeps image recognition available without capability negotiation", async () => {
    context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
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

  it("skips feature switch hydration without an authenticated organization", async () => {
    context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
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
