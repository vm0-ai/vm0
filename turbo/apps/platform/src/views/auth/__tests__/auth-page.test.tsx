import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function setBrowserUrl(url: string): void {
  window.location.href = url;
}

async function withProductionDeployment<T>(
  callback: () => T | Promise<T>,
): Promise<T> {
  vi.stubEnv("VITE_VERCEL_ENV", "production");
  try {
    return await callback();
  } finally {
    vi.stubEnv("VITE_VERCEL_ENV", "");
  }
}

describe("app auth pages", () => {
  it("renders the app-hosted sign-in route", async () => {
    setBrowserUrl("https://app.vm0.ai/sign-in");

    detachedSetupPage({ context, path: "/sign-in" });

    await waitFor(() => {
      expect(screen.getByTestId("clerk-sign-in")).toBeInTheDocument();
    });

    expect(screen.getByTestId("clerk-sign-in")).toHaveAttribute(
      "data-clerk-routing",
      "path",
    );
    expect(screen.getByTestId("clerk-sign-in")).toHaveTextContent("/sign-in");
    expect(screen.getByAltText("VM0")).toHaveAttribute(
      "src",
      "/assets/vm0-logo-dark.svg",
    );
  });

  it("routes nested sign-in task paths to the Clerk sign-in surface", async () => {
    setBrowserUrl("https://app.vm0.ai/sign-in/tasks/choose-organization");

    detachedSetupPage({
      context,
      path: "/sign-in/tasks/choose-organization",
    });

    await waitFor(() => {
      expect(screen.getByTestId("clerk-sign-in")).toBeInTheDocument();
    });

    expect(screen.getByTestId("clerk-sign-in")).toHaveTextContent("/sign-in");
  });

  it("renders the app-hosted sign-in route with an allowed redirect URL", async () => {
    const redirectUrl = "https://app.vm0.ai/_/skeleton";
    const path = `/sign-in?redirect_url=${encodeURIComponent(redirectUrl)}`;
    setBrowserUrl(`https://app.vm0.ai${path}`);

    detachedSetupPage({ context, path });

    await waitFor(() => {
      expect(screen.getByTestId("clerk-sign-in")).toBeInTheDocument();
    });

    expect(screen.getByTestId("clerk-sign-in")).toHaveAttribute(
      "data-clerk-fallback-redirect-url",
      redirectUrl,
    );
    expect(screen.getByTestId("clerk-sign-in")).toHaveAttribute(
      "data-clerk-force-redirect-url",
      redirectUrl,
    );
  });

  it("renders the app-hosted sign-up route with an allowed redirect URL", async () => {
    const redirectUrl = "https://app.vm0.ai/prompt";
    const path = `/sign-up?redirect_url=${encodeURIComponent(redirectUrl)}`;
    setBrowserUrl(`https://app.vm0.ai${path}`);

    detachedSetupPage({ context, path });

    await waitFor(() => {
      expect(screen.getByTestId("clerk-sign-up")).toBeInTheDocument();
    });

    expect(screen.getByTestId("clerk-sign-up")).toHaveAttribute(
      "data-clerk-routing",
      "path",
    );
    expect(screen.getByTestId("clerk-sign-up")).toHaveAttribute(
      "data-clerk-fallback-redirect-url",
      redirectUrl,
    );
    expect(screen.getByTestId("clerk-sign-up")).toHaveAttribute(
      "data-clerk-force-redirect-url",
      redirectUrl,
    );
  });

  it("routes ad-attributed sign-up visits through onboarding", async () => {
    const path = "/sign-up?gclid=click-123&utm_campaign=summer";
    setBrowserUrl(`https://app.vm0.ai${path}`);

    detachedSetupPage({ context, path });

    await waitFor(() => {
      expect(screen.getByTestId("clerk-sign-up")).toBeInTheDocument();
    });

    const redirectUrl = new URL(
      screen.getByTestId("clerk-sign-up").dataset.clerkForceRedirectUrl ?? "",
    );
    expect(redirectUrl.origin).toBe("https://www.vm7.ai:8443");
    expect(redirectUrl.pathname).toBe("/onboarding/491858");
    expect(redirectUrl.searchParams.get("gclid")).toBe("click-123");
    expect(redirectUrl.searchParams.get("utm_campaign")).toBe("summer");
    expect(redirectUrl.searchParams.get("vm0_source")).toBe("homepage");
    expect(redirectUrl.searchParams.get("vm0_experiment")).toBe("491858");
    expect(redirectUrl.searchParams.get("domain")).toBe("api.vm7.ai:8443");
  });

  it("does not add the configured API domain to production onboarding redirects", async () => {
    await withProductionDeployment(async () => {
      const path = "/sign-up?gclid=click-123&utm_campaign=summer";
      setBrowserUrl(`https://app.vm0.ai${path}`);

      detachedSetupPage({ context, path });

      await waitFor(() => {
        expect(screen.getByTestId("clerk-sign-up")).toBeInTheDocument();
      });

      const redirectUrl = new URL(
        screen.getByTestId("clerk-sign-up").dataset.clerkForceRedirectUrl ?? "",
      );
      expect(redirectUrl.pathname).toBe("/onboarding/491858");
      expect(redirectUrl.searchParams.get("gclid")).toBe("click-123");
      expect(redirectUrl.searchParams.has("domain")).toBeFalsy();
    });
  });

  it.each([
    "staging-so.vm6.ai",
    "staging-www.vm6.ai",
    "pr-123-so.vm6.ai",
    "pr-123-www.vm6.ai",
  ])(
    "normalizes staging onboarding sign-up redirect from %s",
    async (hostname) => {
      const redirectUrl = `https://${hostname}/onboarding/2afcf6?domain=pr-123-api.vm6.ai`;
      const path = `/sign-up?redirect_url=${encodeURIComponent(redirectUrl)}`;
      setBrowserUrl(`https://app.vm0.ai${path}`);

      detachedSetupPage({ context, path });

      await waitFor(() => {
        expect(screen.getByTestId("clerk-sign-up")).toBeInTheDocument();
      });

      const normalizedRedirectUrl = new URL(
        screen.getByTestId("clerk-sign-up").dataset.clerkForceRedirectUrl ?? "",
      );
      expect(normalizedRedirectUrl.origin).toBe("https://www.vm7.ai:8443");
      expect(normalizedRedirectUrl.pathname).toBe("/onboarding/2afcf6");
      expect(normalizedRedirectUrl.searchParams.get("domain")).toBe(
        "pr-123-api.vm6.ai",
      );
    },
  );

  it("adds the configured API domain to normalized staging onboarding redirects", async () => {
    const redirectUrl =
      "https://staging-www.vm6.ai/onboarding/2afcf6?vm0_theme=light";
    const path = `/sign-up?redirect_url=${encodeURIComponent(redirectUrl)}`;
    setBrowserUrl(`https://app.vm0.ai${path}`);

    detachedSetupPage({ context, path });

    await waitFor(() => {
      expect(screen.getByTestId("clerk-sign-up")).toBeInTheDocument();
    });

    const normalizedRedirectUrl = new URL(
      screen.getByTestId("clerk-sign-up").dataset.clerkForceRedirectUrl ?? "",
    );
    expect(normalizedRedirectUrl.origin).toBe("https://www.vm7.ai:8443");
    expect(normalizedRedirectUrl.pathname).toBe("/onboarding/2afcf6");
    expect(normalizedRedirectUrl.searchParams.get("vm0_theme")).toBe("light");
    expect(normalizedRedirectUrl.searchParams.get("domain")).toBe(
      "api.vm7.ai:8443",
    );
  });
});
