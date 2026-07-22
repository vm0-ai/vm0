import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { searchParams$ } from "../../../signals/route.ts";
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

  it("does not register the retired numeric onboarding path", async () => {
    detachedSetupPage({
      context,
      path: "/onboarding/491858?vm0_source=homepage",
    });

    await expect(
      screen.findByRole("heading", { name: "Page not found" }),
    ).resolves.toBeInTheDocument();
    expect(pathname()).toBe("/onboarding/491858");
  });
});
