import { screen, waitFor } from "@testing-library/react";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import { afterAll, expect, test, vi } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";

// Keep the Onboarding -> Chat route transforms outside assertion timeouts.
// Production still resolves these groups lazily after route matching.
import "../../../signals/route-setups/onboarding.ts";
import "../../../signals/route-setups/chat.ts";

type Capture = (
  eventName: string,
  properties?: Record<string, unknown>,
) => void;
type Identify = (
  distinctId: string,
  properties?: Record<string, unknown>,
) => void;
type Init = (key: string, config?: unknown) => void;
type Register = (properties: Record<string, unknown>) => void;
type Reset = () => void;
type Unregister = (property: string) => void;

const { apiOriginMarker, posthog } = vi.hoisted(() => {
  vi.stubEnv("VITE_POSTHOG_KEY", "phc_test_key");
  window.location.href = "https://app.vm0.ai/";
  const apiOriginMarker = document.createElement("meta");
  apiOriginMarker.name = "vm0-api-origin";
  apiOriginMarker.content = "https://api.vm0.ai";
  document.head.append(apiOriginMarker);
  return {
    apiOriginMarker,
    posthog: {
      capture: vi.fn<Capture>(),
      identify: vi.fn<Identify>(),
      init: vi.fn<Init>(),
      register: vi.fn<Register>(),
      reset: vi.fn<Reset>(),
      unregister: vi.fn<Unregister>(),
    },
  };
});

vi.mock("posthog-js/dist/module.slim", () => {
  return { posthog };
});

const context = testContext();

afterAll(() => {
  apiOriginMarker.remove();
});

function buttonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.includes(text) ?? false;
  });
  if (!button) {
    throw new Error(`Button not found for ${text}`);
  }
  return button;
}

function roleConfirmedCalls(): unknown[][] {
  return posthog.capture.mock.calls.filter(([eventName]) => {
    return eventName === "PaidOnboarding: RoleConfirmed";
  });
}

test("reports the final role for the identified user after onboarding completes", async () => {
  const completion = createDeferredPromise<void>(context.signal);
  const completionStarted = vi.fn<() => void>();
  context.mocks.api(
    onboardingCompleteContract.complete,
    async ({ respond }) => {
      completionStarted();
      await completion.promise;
      return respond(200, {
        onboardingComplete: true,
        needsOnboarding: false,
      });
    },
  );
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });

  detachedSetupPage({ context, path: "/onboarding" });
  await expect(
    screen.findByRole("heading", { name: "What do you want to make first" }),
  ).resolves.toBeInTheDocument();
  click(screen.getByRole("radio", { name: /Workflow automation/u }));

  await expect(
    screen.findByRole("heading", { name: "What do you work on?" }),
  ).resolves.toBeInTheDocument();
  click(buttonByText("Engineer"));
  await expect(
    screen.findByRole("heading", { name: "Engineer workflows" }),
  ).resolves.toBeInTheDocument();
  click(buttonByText("Talk to Zero and make my own"));

  await waitFor(() => {
    expect(completionStarted).toHaveBeenCalledOnce();
  });
  expect(roleConfirmedCalls()).toStrictEqual([]);

  completion.resolve();
  await waitFor(() => {
    expect(roleConfirmedCalls()).toStrictEqual([
      [
        "PaidOnboarding: RoleConfirmed",
        expect.objectContaining({
          flow: "paid_onboarding",
          role: "engineering",
        }),
      ],
    ]);
    expect(pathname()).not.toMatch(/^\/onboarding/u);
  });
  expect(posthog.identify).toHaveBeenCalledWith("test-user-123", {
    email: undefined,
    name: "Test User",
  });
});
