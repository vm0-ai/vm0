import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { detachedSetupPage, setupPage } from "../../__tests__/page-helper.ts";
import {
  featureSwitch$,
  zeroImageRecognitionEnabled$,
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
  });

  it("keeps custom connector OAuth disabled when the API lacks support", async () => {
    context.mocks.api(zeroFeatureSwitchesContract.get, ({ respond }) => {
      return respond(200, {
        switches: { [FeatureSwitchKey.CustomConnectorOAuth2]: true },
        effectiveSwitches: {
          [FeatureSwitchKey.CustomConnectorOAuth2]: true,
        },
        supportsStructuredInlineTemplates: true,
      });
    });

    await setupPage({
      context,
      path: "/error",
      withoutRender: true,
    });

    expect(
      context.store.get(featureSwitch$)[FeatureSwitchKey.CustomConnectorOAuth2],
    ).toBeFalsy();
  });

  it("keeps custom model gateways disabled when the API lacks support", async () => {
    context.mocks.api(zeroFeatureSwitchesContract.get, ({ respond }) => {
      return respond(200, {
        switches: { [FeatureSwitchKey.CustomModelGateways]: true },
        effectiveSwitches: {
          [FeatureSwitchKey.CustomModelGateways]: true,
        },
        supportsStructuredInlineTemplates: true,
        supportsCustomConnectorOAuth2: true,
      });
    });

    await setupPage({
      context,
      path: "/error",
      withoutRender: true,
    });

    expect(
      context.store.get(featureSwitch$)[FeatureSwitchKey.CustomModelGateways],
    ).toBeFalsy();
  });

  it("keeps image recognition disabled when the API lacks support", async () => {
    context.mocks.api(zeroFeatureSwitchesContract.get, ({ respond }) => {
      return respond(200, {
        switches: { [FeatureSwitchKey.ZeroImageRecognition]: true },
        effectiveSwitches: {
          [FeatureSwitchKey.ZeroImageRecognition]: true,
        },
        supportsStructuredInlineTemplates: true,
        supportsCustomConnectorOAuth2: true,
        supportsCustomModelGateways: true,
      });
    });

    await setupPage({
      context,
      path: "/error",
      withoutRender: true,
    });

    expect(context.store.get(zeroImageRecognitionEnabled$)).toBeFalsy();
  });

  it("waits for current API support before trusting cached image recognition", async () => {
    context.mocks.api(zeroFeatureSwitchesContract.get, ({ respond }) => {
      return respond(200, {
        switches: { [FeatureSwitchKey.ZeroImageRecognition]: true },
        effectiveSwitches: {
          [FeatureSwitchKey.ZeroImageRecognition]: true,
        },
        supportsStructuredInlineTemplates: true,
        supportsCustomConnectorOAuth2: true,
        supportsCustomModelGateways: true,
        supportsImageRecognition: true,
      });
    });

    detachedSetupPage({
      context,
      path: "/error",
      featureSwitches: {
        [FeatureSwitchKey.ZeroImageRecognition]: true,
      },
      withoutRender: true,
    });

    expect(context.store.get(zeroImageRecognitionEnabled$)).toBeFalsy();
    await waitFor(() => {
      expect(context.store.get(zeroImageRecognitionEnabled$)).toBeTruthy();
    });
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
