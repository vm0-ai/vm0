import { waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { detachedSetupPage } from "../../__tests__/page-helper.ts";
import {
  resolveAppAuthUrl,
  resolveWebAuthUrl,
  resolveWebOrigin,
} from "../auth.ts";
import { testContext } from "./test-helpers.ts";

const context = testContext();
const AUTH_ORIGIN = "https://www.vm7.ai:8443";
const AUTH_DOMAIN = "api.vm7.ai:8443";

function setBrowserUrl(url: string): void {
  window.location.href = url;
}

async function withoutConfiguredOnboarding<T>(
  callback: () => T | Promise<T>,
): Promise<T> {
  vi.stubEnv("VITE_ONBOARDING_URL", "");
  vi.stubEnv("VITE_ONBOARDING_DOMAIN", "");
  try {
    return await callback();
  } finally {
    vi.stubEnv("VITE_ONBOARDING_URL", AUTH_ORIGIN);
    vi.stubEnv("VITE_ONBOARDING_DOMAIN", AUTH_DOMAIN);
  }
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

describe("platform auth URLs", () => {
  it("uses the configured onboarding origin for web/onboarding URLs", () => {
    setBrowserUrl("https://pr-18532-app.vm6.ai/agents");

    expect(resolveWebOrigin()).toBe(AUTH_ORIGIN);
  });

  it("builds app auth URLs with the configured API domain override", () => {
    setBrowserUrl("https://pr-18532-app.vm6.ai/agents");

    const signInUrl = new URL(resolveAppAuthUrl("/sign-in"));
    expect(signInUrl.origin).toBe("https://pr-18532-app.vm6.ai");
    expect(signInUrl.pathname).toBe("/sign-in");
    expect(signInUrl.searchParams.get("domain")).toBe(AUTH_DOMAIN);

    const chooseOrgUrl = new URL(
      resolveAppAuthUrl("/sign-in/tasks/choose-organization"),
    );
    expect(chooseOrgUrl.origin).toBe("https://pr-18532-app.vm6.ai");
    expect(chooseOrgUrl.pathname).toBe("/sign-in/tasks/choose-organization");
    expect(chooseOrgUrl.searchParams.get("domain")).toBe(AUTH_DOMAIN);

    const redirectUrl = new URL(
      resolveAppAuthUrl("/sign-in", {
        redirectUrl: "https://pr-18532-app.vm6.ai/",
      }),
    );
    expect(redirectUrl.origin).toBe("https://pr-18532-app.vm6.ai");
    expect(redirectUrl.pathname).toBe("/sign-in");
    expect(redirectUrl.searchParams.get("domain")).toBe(AUTH_DOMAIN);
    expect(redirectUrl.searchParams.get("redirect_url")).toBe(
      "https://pr-18532-app.vm6.ai/",
    );
  });

  it("keeps legacy web auth URLs available for onboarding-hosted flows", () => {
    setBrowserUrl("https://pr-18532-app.vm6.ai/agents");

    const signInUrl = new URL(resolveWebAuthUrl("/sign-in"));
    expect(signInUrl.origin).toBe(AUTH_ORIGIN);
    expect(signInUrl.pathname).toBe("/sign-in");
    expect(signInUrl.searchParams.get("domain")).toBe(AUTH_DOMAIN);
  });

  it("falls back to a derived vm6 API override for app auth without configured onboarding", async () => {
    await withoutConfiguredOnboarding(() => {
      setBrowserUrl("https://pr-18532-app.vm6.ai/agents");

      const url = new URL(resolveAppAuthUrl("/sign-in"));
      expect(url.origin).toBe("https://pr-18532-app.vm6.ai");
      expect(url.searchParams.get("domain")).toBe("pr-18532-api.vm6.ai");
    });
  });

  it("does not add a fallback domain override outside vm6 preview origins", async () => {
    await withoutConfiguredOnboarding(() => {
      setBrowserUrl("https://app.vm0.ai/agents");

      expect(resolveAppAuthUrl("/sign-in")).toBe("https://app.vm0.ai/sign-in");
    });
  });

  it("uses app auth in production without domain override", async () => {
    await withProductionDeployment(() => {
      setBrowserUrl("https://app.vm0.ai/agents");

      const url = new URL(resolveAppAuthUrl("/sign-in"));
      expect(url.origin).toBe("https://app.vm0.ai");
      expect(url.pathname).toBe("/sign-in");
      expect(url.searchParams.has("domain")).toBeFalsy();
    });
  });
});

describe("platform auth redirects", () => {
  it("redirects unauthenticated users to app auth with API domain override", async () => {
    setBrowserUrl("https://pr-18532-app.vm6.ai/agents");

    detachedSetupPage({
      context,
      path: "/agents",
      session: null,
      user: null,
    });

    await waitFor(() => {
      const url = new URL(window.location.href);
      expect(url.origin).toBe("https://pr-18532-app.vm6.ai");
      expect(url.pathname).toBe("/sign-in");
      expect(url.searchParams.get("domain")).toBe(AUTH_DOMAIN);
      expect(url.searchParams.get("redirect_url")).toBe(
        "https://pr-18532-app.vm6.ai/agents",
      );
    });
  });

  it("redirects users who need org selection to configured auth", async () => {
    setBrowserUrl("https://pr-18532-app.vm6.ai/agents");

    detachedSetupPage({
      context,
      org: {
        activeOrg: null,
        memberships: [{ id: "org_member" }],
      },
      path: "/agents",
    });

    await waitFor(() => {
      const url = new URL(window.location.href);
      expect(url.origin).toBe("https://pr-18532-app.vm6.ai");
      expect(url.pathname).toBe("/sign-in/tasks/choose-organization");
      expect(url.searchParams.get("domain")).toBe(AUTH_DOMAIN);
    });
  });

  it("uses app auth for non-preview org selection", async () => {
    await withoutConfiguredOnboarding(async () => {
      setBrowserUrl("https://app.vm0.ai/agents");

      detachedSetupPage({
        context,
        org: {
          activeOrg: null,
          memberships: [{ id: "org_member" }],
        },
        path: "/agents",
      });

      await waitFor(() => {
        const url = new URL(window.location.href);
        expect(url.origin).toBe("https://app.vm0.ai");
        expect(url.pathname).toBe("/sign-in/tasks/choose-organization");
        expect(url.searchParams.has("domain")).toBeFalsy();
      });
    });
  });
});
