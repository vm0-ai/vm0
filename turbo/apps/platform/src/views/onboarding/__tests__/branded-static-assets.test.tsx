import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

describe("branded onboarding static assets", () => {
  it(
    "renders Okou presentation templates from static.okou.io",
    { timeout: 15_000 },
    async () => {
      vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY_PROD", "pk_live_production");
      vi.stubEnv("VITE_VAPID_PUBLIC_KEY_PROD", "production_vapid_key");
      context.mocks.browser.url(
        "https://app.okou.ai/onboarding/presentation-template",
      );
      context.mocks.data.onboardingStatus({
        needsOnboarding: true,
        onboardingComplete: false,
      });

      const { detachedSetupPage } =
        await import("../../../__tests__/page-helper.ts");
      detachedSetupPage({
        context,
        path: "/onboarding/presentation-template?choice=presentation",
      });

      await expect(
        screen.findByRole("heading", {
          name: "Pick a presentation template to start from",
        }),
      ).resolves.toBeInTheDocument();

      await waitFor(() => {
        expect(document.querySelectorAll("article img").length).toBeGreaterThan(
          0,
        );
      });
      const templateImageSources = Array.from(
        document.querySelectorAll<HTMLImageElement>("article img"),
        (image) => {
          return image.src;
        },
      );
      expect(
        templateImageSources.every((source) => {
          return new URL(source).hostname === "static.okou.io";
        }),
      ).toBeTruthy();
    },
  );
});
