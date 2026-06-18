import { onboardingStatusContract } from "@vm0/api-contracts/contracts/onboarding";
import { zeroConnectorsMainContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function mockOnboardingNeeded(): void {
  context.mocks.api(onboardingStatusContract.getStatus, ({ respond }) => {
    return respond(200, {
      needsOnboarding: true,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: false,
      defaultAgentId: null,
      defaultAgentMetadata: null,
    });
  });
}

describe("zero onboarding", () => {
  it("redirects admins who need onboarding to paid onboarding with query params", async () => {
    mockOnboardingNeeded();

    detachedSetupPage({
      context,
      path: "/?prompt=hello%20world&connector=github&vm0_source=presentation",
    });

    await waitFor(() => {
      const url = new URL(window.location.href);
      expect(url.origin).toBe("https://so.vm7.ai:8443");
      expect(url.pathname).toBe("/onboarding/2afcf6");
      expect(url.searchParams.get("prompt")).toBe("hello world");
      expect(url.searchParams.get("connector")).toBe("github");
      expect(url.searchParams.get("vm0_source")).toBe("presentation");
      expect(url.searchParams.get("domain")).toBe("api.vm7.ai:8443");
    });
  });

  it("redirects direct onboarding visits to paid onboarding", async () => {
    detachedSetupPage({
      context,
      path: "/onboarding?prompt=hello%20world&connector=github&vm0_source=presentation",
    });

    await waitFor(() => {
      const url = new URL(window.location.href);
      expect(url.origin).toBe("https://so.vm7.ai:8443");
      expect(url.pathname).toBe("/onboarding/2afcf6");
      expect(url.searchParams.get("prompt")).toBe("hello world");
      expect(url.searchParams.get("connector")).toBe("github");
      expect(url.searchParams.get("vm0_source")).toBe("presentation");
      expect(url.searchParams.get("domain")).toBe("api.vm7.ai:8443");
    });
  });

  it("redirects direct paid onboarding without loading connectors first", async () => {
    context.mocks.api(zeroConnectorsMainContract.list, ({ respond }) => {
      return respond(500, {
        error: {
          message: "Failed to load connectors",
          code: "INTERNAL_SERVER_ERROR",
        },
      });
    });

    detachedSetupPage({
      context,
      path: "/onboarding?prompt=hello%20world&connector=github&vm0_source=presentation",
    });

    await waitFor(() => {
      const url = new URL(window.location.href);
      expect(url.origin).toBe("https://so.vm7.ai:8443");
      expect(url.pathname).toBe("/onboarding/2afcf6");
      expect(url.searchParams.get("prompt")).toBe("hello world");
      expect(url.searchParams.get("connector")).toBe("github");
      expect(url.searchParams.get("vm0_source")).toBe("presentation");
      expect(url.searchParams.get("domain")).toBe("api.vm7.ai:8443");
    });
  });
});
