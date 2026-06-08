import { beforeEach, describe, expect, it, vi } from "vitest";

const posthogMock = vi.hoisted(() => {
  return {
    init: vi.fn(),
    identify: vi.fn(),
    reset: vi.fn(),
    capture: vi.fn(),
    startSessionRecording: vi.fn(),
    stopSessionRecording: vi.fn(),
  };
});

vi.mock("posthog-js", () => {
  return { posthog: posthogMock };
});

async function loadPostHog(posthogKey: string) {
  vi.resetModules();
  vi.stubEnv("VITE_POSTHOG_KEY", posthogKey);
  return await import("../posthog.ts");
}

describe("posthog analytics helpers", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_POSTHOG_KEY", "");
  });

  it("skips activation captures when PostHog is disabled", async () => {
    const { captureOnboardingStep, captureTaskCompletedSuccessfully } =
      await loadPostHog("");

    captureOnboardingStep("1");
    captureTaskCompletedSuccessfully();

    expect(posthogMock.capture).not.toHaveBeenCalled();
  });

  it("captures onboarding step views", async () => {
    const { captureOnboardingStep } = await loadPostHog("test-posthog-key");

    captureOnboardingStep("2");

    expect(posthogMock.capture).toHaveBeenCalledWith("onboarding_step_viewed", {
      step: "2",
    });
  });

  it("captures successful chat-thread task completions", async () => {
    const { captureTaskCompletedSuccessfully } =
      await loadPostHog("test-posthog-key");

    captureTaskCompletedSuccessfully();

    expect(posthogMock.capture).toHaveBeenCalledWith(
      "task_completed_successfully",
      { surface: "chat_thread" },
    );
  });
});
