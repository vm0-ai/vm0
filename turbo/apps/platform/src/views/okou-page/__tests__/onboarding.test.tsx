import { onboardingStatusContract } from "@okouai/api-contracts/contracts/onboarding";
import { screen } from "@testing-library/react";
import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import {
  detachedSetupPage,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockOrganization } from "../../../__tests__/mock-auth.ts";
import { pathname } from "../../../signals/location.ts";
import { detachedNavigateTo$, searchParams$ } from "../../../signals/route.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function mockOnboardingNeeded(): void {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
}

describe("zero onboarding routing", () => {
  it("routes a new user into the internal prompt onboarding page", async () => {
    mockOnboardingNeeded();

    detachedSetupPage({
      context,
      path: "/?prompt=hello%20world&connector=github&vm0_source=presentation",
    });

    await expect(
      screen.findByRole("heading", { name: "Try this prompt" }),
    ).resolves.toBeInTheDocument();
    expect(pathname()).toBe("/onboarding");
    expect(context.store.get(searchParams$).get("prompt")).toBe("hello world");
    expect(context.store.get(searchParams$).get("connector")).toBe("github");
    expect(context.store.get(searchParams$).get("vm0_source")).toBe(
      "presentation",
    );
    expect(screen.getByLabelText("Onboarding prompt")).toHaveValue(
      "hello world",
    );
  });

  it("preserves onboarding coverage for a legacy redirect route", async () => {
    mockOnboardingNeeded();

    detachedSetupPage({ context, path: "/team" });

    await expect(
      screen.findByRole("heading", { name: "What do you want to make first" }),
    ).resolves.toBeInTheDocument();
    expect(pathname()).toBe(ROUTES.onboarding);
  });

  it("fails open when onboarding status is unavailable", async () => {
    context.mocks.http.get("*/api/onboarding/status", () => {
      return new HttpResponse(null, { status: 500 });
    });

    detachedSetupPage({ context, path: ROUTES.exportData });

    await expect(
      screen.findByRole("heading", { level: 1, name: "Export data" }),
    ).resolves.toBeInTheDocument();
    expect(pathname()).toBe(ROUTES.exportData);
  });

  it("fails open when the authenticated organization changes", async () => {
    const statusRequestStarted = context.mocks.deferred<void>();
    const releaseStatusRequest = context.mocks.deferred<void>();
    context.mocks.api(
      onboardingStatusContract.getStatus,
      async ({ respond }) => {
        statusRequestStarted.resolve(undefined);
        await releaseStatusRequest.promise;
        return respond(200, {
          needsOnboarding: true,
          onboardingComplete: false,
          isAdmin: true,
          hasOrg: true,
          hasDefaultAgent: false,
          defaultAgentId: null,
          defaultAgentMetadata: null,
        });
      },
    );

    const setup = setupPage({ context, path: ROUTES.exportData });
    await statusRequestStarted.promise;
    mockOrganization({
      activeOrg: { id: "org_next", name: "Next organization" },
      memberships: [{ id: "org_next" }],
    });
    releaseStatusRequest.resolve(undefined);
    await setup;

    await expect(
      screen.findByRole("heading", { level: 1, name: "Export data" }),
    ).resolves.toBeInTheDocument();
    expect(pathname()).toBe(ROUTES.exportData);
  });

  it("does not rerun the guard after an exempt initial bootstrap", async () => {
    let statusRequests = 0;
    context.mocks.http.get("*/api/onboarding/status", () => {
      statusRequests += 1;
      return HttpResponse.json({
        needsOnboarding: true,
        onboardingComplete: false,
        isAdmin: true,
        hasOrg: true,
        hasDefaultAgent: false,
        defaultAgentId: null,
        defaultAgentMetadata: null,
      });
    });

    await setupPage({ context, path: ROUTES.skeleton });
    expect(statusRequests).toBe(0);

    context.store.set(detachedNavigateTo$, ROUTES.exportData, {
      replace: true,
    });
    await expect(
      screen.findByRole("heading", { level: 1, name: "Export data" }),
    ).resolves.toBeInTheDocument();
    expect(statusRequests).toBe(0);
  });

  it("does not register nested onboarding paths", async () => {
    detachedSetupPage({
      context,
      path: "/onboarding/unknown?vm0_source=homepage",
    });

    await expect(
      screen.findByRole("heading", { name: "Page not found" }),
    ).resolves.toBeInTheDocument();
    expect(pathname()).toBe("/onboarding/unknown");
  });
});
