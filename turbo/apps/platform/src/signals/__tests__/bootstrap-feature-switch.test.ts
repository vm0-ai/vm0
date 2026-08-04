import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { detachedSetupPage, setupPage } from "../../__tests__/page-helper.ts";
import {
  avatarTemplatesEnabled$,
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

  it("enables image recognition from the stable API capability", async () => {
    context.mocks.api(zeroFeatureSwitchesContract.get, ({ respond }) => {
      return respond(200, {
        switches: {},
        effectiveSwitches: {},
        supportsStructuredInlineTemplates: true,
        supportsCustomConnectorOAuth2: true,
        supportsCustomModelGateways: true,
        supportsImageRecognition: true,
      });
    });

    await setupPage({
      context,
      path: "/error",
      withoutRender: true,
    });

    expect(context.store.get(imageRecognitionAvailable$)).toBeTruthy();
  });

  it("keeps image recognition unavailable when the API omits support", async () => {
    context.mocks.api(zeroFeatureSwitchesContract.get, ({ respond }) => {
      return respond(200, {
        switches: {},
        effectiveSwitches: {},
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

    expect(context.store.get(imageRecognitionAvailable$)).toBeFalsy();
  });

  it("keeps image recognition unavailable when the API disables support", async () => {
    context.mocks.api(zeroFeatureSwitchesContract.get, ({ respond }) => {
      return respond(200, {
        switches: {},
        effectiveSwitches: {},
        supportsStructuredInlineTemplates: true,
        supportsCustomConnectorOAuth2: true,
        supportsCustomModelGateways: true,
        supportsImageRecognition: false,
      });
    });

    await setupPage({
      context,
      path: "/error",
      withoutRender: true,
    });

    expect(context.store.get(imageRecognitionAvailable$)).toBeFalsy();
  });

  it("keeps avatar templates disabled when the API lacks support", async () => {
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

    expect(context.store.get(avatarTemplatesEnabled$)).toBeFalsy();
  });

  it("waits for current API support before trusting cached avatar templates", async () => {
    context.mocks.api(zeroFeatureSwitchesContract.get, ({ respond }) => {
      return respond(200, {
        switches: { [FeatureSwitchKey.JoggAiBuiltIn]: true },
        effectiveSwitches: { [FeatureSwitchKey.JoggAiBuiltIn]: true },
        supportsAvatarTemplates: true,
      });
    });

    detachedSetupPage({
      context,
      path: "/error",
      featureSwitches: { [FeatureSwitchKey.JoggAiBuiltIn]: true },
      withoutRender: true,
    });

    expect(context.store.get(avatarTemplatesEnabled$)).toBeFalsy();
    await waitFor(() => {
      expect(context.store.get(avatarTemplatesEnabled$)).toBeTruthy();
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
