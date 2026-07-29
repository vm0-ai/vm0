import { beforeEach, describe, expect, it, vi } from "vitest";

const posthogMock = vi.hoisted(() => {
  return {
    init: vi.fn(),
    identify: vi.fn(),
    reset: vi.fn(),
    capture: vi.fn(),
  };
});

vi.mock("posthog-js", () => {
  return { posthog: posthogMock };
});

async function loadPostHog(posthogKey: string) {
  vi.resetModules();
  vi.stubGlobal("location", { hostname: "vm0.ai" });
  vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY_PROD", "test-clerk-key");
  vi.stubEnv("VITE_POSTHOG_KEY", posthogKey);
  return await import("../posthog.ts");
}

describe("posthog analytics helpers", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_POSTHOG_KEY", "");
    posthogMock.capture.mockClear();
  });

  it("skips paid onboarding captures when PostHog is disabled", async () => {
    const {
      capturePaidOnboardingPageViewed,
      capturePaidOnboardingStepCompleted,
      capturePaidOnboardingStepViewed,
    } = await loadPostHog("");

    capturePaidOnboardingPageViewed();
    capturePaidOnboardingStepViewed("make");
    capturePaidOnboardingStepCompleted({
      stepKey: "make",
      completionMethod: "workflow",
    });

    expect(posthogMock.capture).not.toHaveBeenCalled();
  });

  it("captures the paid onboarding event contract", async () => {
    const {
      capturePaidOnboardingPageViewed,
      capturePaidOnboardingStepCompleted,
      capturePaidOnboardingStepViewed,
    } = await loadPostHog("test-posthog-key");

    capturePaidOnboardingPageViewed();
    capturePaidOnboardingStepViewed("make");
    capturePaidOnboardingStepCompleted({
      stepKey: "make",
      completionMethod: "workflow",
    });

    expect(posthogMock.capture).toHaveBeenNthCalledWith(
      1,
      "PaidOnboarding: PageViewed",
      expect.objectContaining({
        surface: "vm0_make_onboarding",
      }),
    );
    expect(posthogMock.capture).toHaveBeenNthCalledWith(
      2,
      "PaidOnboarding: StepViewed",
      expect.objectContaining({
        step_key: "make",
      }),
    );
    expect(posthogMock.capture).toHaveBeenNthCalledWith(
      3,
      "PaidOnboarding: StepCompleted",
      expect.objectContaining({
        completion_method: "workflow",
        step_key: "make",
      }),
    );
  });
});
