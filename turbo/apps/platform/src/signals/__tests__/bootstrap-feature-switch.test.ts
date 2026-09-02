import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { setupPage } from "../../__tests__/page-helper.ts";
import {
  emitMockedClerkEvent,
  mockClerkSessionTransitioning,
  mockOrganization,
  mockUser,
} from "../../__tests__/mock-auth.ts";
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

  it("cancels hydration when the SSO callback clears the identity", async () => {
    const requestStarted = context.mocks.deferred<void>();
    context.mocks.api(featureSwitchesContract.get, ({ never }) => {
      requestStarted.resolve(undefined);
      return never();
    });

    const setup = setupPage({
      context,
      path: "/sign-up/sso-callback",
      cachedFeatureSwitches: { [FeatureSwitchKey.AhrefsConnector]: false },
      withoutRender: true,
    });
    await requestStarted.promise;

    mockUser(null, null);
    mockOrganization({ activeOrg: null, memberships: [] });
    emitMockedClerkEvent();

    await setup;
    expect(
      context.store.get(featureSwitch$)[FeatureSwitchKey.AhrefsConnector],
    ).toBeFalsy();
  });

  it("does not apply a response after an unannounced user change", async () => {
    const requestStarted = context.mocks.deferred<void>();
    const releaseResponse = context.mocks.deferred<void>();
    context.mocks.api(featureSwitchesContract.get, async ({ respond }) => {
      requestStarted.resolve(undefined);
      await releaseResponse.promise;
      return respond(200, {
        switches: { [FeatureSwitchKey.AhrefsConnector]: true },
        effectiveSwitches: { [FeatureSwitchKey.AhrefsConnector]: true },
      });
    });

    const setup = setupPage({
      context,
      path: "/error",
      cachedFeatureSwitches: { [FeatureSwitchKey.AhrefsConnector]: false },
      withoutRender: true,
    });
    await requestStarted.promise;

    mockUser(
      { id: "replacement-user", fullName: "Replacement User" },
      { token: "replacement-token" },
    );
    releaseResponse.resolve(undefined);

    await setup;
    expect(
      context.store.get(featureSwitch$)[FeatureSwitchKey.AhrefsConnector],
    ).toBeFalsy();
  });

  it("keeps an org refresh request stale after the organization returns", async () => {
    const requestStarted = context.mocks.deferred<void>();
    context.mocks.api(featureSwitchesContract.get, ({ never }) => {
      requestStarted.resolve(undefined);
      return never();
    });

    const setup = setupPage({
      context,
      path: "/error",
      cachedFeatureSwitches: { [FeatureSwitchKey.AhrefsConnector]: false },
      org: {
        activeOrg: { id: "org_A", name: "Org A" },
        memberships: [{ id: "org_A" }],
      },
      withoutRender: true,
    });
    await requestStarted.promise;

    mockOrganization({ activeOrg: null, memberships: [{ id: "org_A" }] });
    emitMockedClerkEvent();
    mockOrganization({
      activeOrg: { id: "org_A", name: "Org A" },
      memberships: [{ id: "org_A" }],
    });
    emitMockedClerkEvent();

    await setup;
    expect(
      context.store.get(featureSwitch$)[FeatureSwitchKey.AhrefsConnector],
    ).toBeFalsy();
  });

  it("cancels hydration while the Clerk session is transitioning", async () => {
    const requestStarted = context.mocks.deferred<void>();
    context.mocks.api(featureSwitchesContract.get, ({ never }) => {
      requestStarted.resolve(undefined);
      return never();
    });

    const setup = setupPage({
      context,
      path: "/error",
      cachedFeatureSwitches: { [FeatureSwitchKey.AhrefsConnector]: false },
      withoutRender: true,
    });
    await requestStarted.promise;

    mockClerkSessionTransitioning(true);
    mockClerkSessionTransitioning(false);

    await setup;
    expect(
      context.store.get(featureSwitch$)[FeatureSwitchKey.AhrefsConnector],
    ).toBeFalsy();
  });

  it("keeps hydration active for a Clerk event with the same identity", async () => {
    const requestStarted = context.mocks.deferred<void>();
    const releaseResponse = context.mocks.deferred<void>();
    context.mocks.api(featureSwitchesContract.get, async ({ respond }) => {
      requestStarted.resolve(undefined);
      await releaseResponse.promise;
      return respond(200, {
        switches: { [FeatureSwitchKey.AhrefsConnector]: true },
        effectiveSwitches: { [FeatureSwitchKey.AhrefsConnector]: true },
      });
    });

    const setup = setupPage({
      context,
      path: "/error",
      cachedFeatureSwitches: { [FeatureSwitchKey.AhrefsConnector]: false },
      withoutRender: true,
    });
    await requestStarted.promise;

    emitMockedClerkEvent();
    releaseResponse.resolve(undefined);

    await setup;
    expect(
      context.store.get(featureSwitch$)[FeatureSwitchKey.AhrefsConnector],
    ).toBeTruthy();
  });
});
