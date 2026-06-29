import { waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { detachedSetupPage } from "../../__tests__/page-helper.ts";
import { resolveWebAuthUrl, resolveWebOrigin } from "../auth.ts";
import { testContext } from "./test-helpers.ts";

const context = testContext();
const AUTH_ORIGIN = "https://so.vm7.ai:8443";
const AUTH_DOMAIN = "api.vm7.ai:8443";

function setBrowserUrl(url: string): void {
  window.location.href = url;
}

async function withoutConfiguredOnboarding<T>(
  callback: () => T | Promise<T>,
): Promise<T> {
  vi.stubEnv("VITE_PAID_ONBOARDING_URL", "");
  vi.stubEnv("VITE_PAID_ONBOARDING_DOMAIN", "");
  try {
    return await callback();
  } finally {
    vi.stubEnv("VITE_PAID_ONBOARDING_URL", AUTH_ORIGIN);
    vi.stubEnv("VITE_PAID_ONBOARDING_DOMAIN", AUTH_DOMAIN);
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
  it("uses the configured onboarding origin for auth URLs", () => {
    setBrowserUrl("https://pr-18532-app.vm6.ai/agents");

    expect(resolveWebOrigin()).toBe(AUTH_ORIGIN);
  });

  it("adds the configured API domain override to auth URLs", () => {
    setBrowserUrl("https://pr-18532-app.vm6.ai/agents");

    const signInUrl = new URL(resolveWebAuthUrl("/sign-in"));
    expect(signInUrl.origin).toBe(AUTH_ORIGIN);
    expect(signInUrl.pathname).toBe("/sign-in");
    expect(signInUrl.searchParams.get("domain")).toBe(AUTH_DOMAIN);

    const chooseOrgUrl = new URL(
      resolveWebAuthUrl("/sign-in/tasks/choose-organization"),
    );
    expect(chooseOrgUrl.origin).toBe(AUTH_ORIGIN);
    expect(chooseOrgUrl.pathname).toBe("/sign-in/tasks/choose-organization");
    expect(chooseOrgUrl.searchParams.get("domain")).toBe(AUTH_DOMAIN);

    const redirectUrl = new URL(
      resolveWebAuthUrl("/sign-in", {
        redirectUrl: "https://pr-18532-app.vm6.ai/",
      }),
    );
    expect(redirectUrl.origin).toBe(AUTH_ORIGIN);
    expect(redirectUrl.pathname).toBe("/sign-in");
    expect(redirectUrl.searchParams.get("domain")).toBe(AUTH_DOMAIN);
    expect(redirectUrl.searchParams.get("redirect_url")).toBe(
      "https://pr-18532-app.vm6.ai/",
    );
  });

  it("falls back to derived vm6 web and API origins without configured onboarding", async () => {
    await withoutConfiguredOnboarding(() => {
      setBrowserUrl("https://pr-18532-app.vm6.ai/agents");

      const url = new URL(resolveWebAuthUrl("/sign-in"));
      expect(url.origin).toBe("https://pr-18532-www.vm6.ai");
      expect(url.searchParams.get("domain")).toBe("pr-18532-api.vm6.ai");
    });
  });

  it("does not add a fallback domain override outside vm6 preview origins", async () => {
    await withoutConfiguredOnboarding(() => {
      setBrowserUrl("https://app.vm0.ai/agents");

      expect(resolveWebAuthUrl("/sign-in")).toBe("https://www.vm0.ai/sign-in");
    });
  });

  it("keeps production auth on the derived web origin", async () => {
    await withProductionDeployment(() => {
      setBrowserUrl("https://app.vm0.ai/agents");

      const url = new URL(resolveWebAuthUrl("/sign-in"));
      expect(url.origin).toBe("https://www.vm0.ai");
      expect(url.pathname).toBe("/sign-in");
      expect(url.searchParams.has("domain")).toBeFalsy();
    });
  });
});

describe("platform auth redirects", () => {
  it("redirects unauthenticated users to configured auth with API domain override", async () => {
    setBrowserUrl("https://pr-18532-app.vm6.ai/agents");

    detachedSetupPage({
      context,
      path: "/agents",
      session: null,
      user: null,
    });

    await waitFor(() => {
      const url = new URL(window.location.href);
      expect(url.origin).toBe(AUTH_ORIGIN);
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
      expect(url.origin).toBe(AUTH_ORIGIN);
      expect(url.pathname).toBe("/sign-in/tasks/choose-organization");
      expect(url.searchParams.get("domain")).toBe(AUTH_DOMAIN);
    });
  });

  it("falls back to derived web auth for non-preview org selection", async () => {
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
        expect(url.origin).toBe("https://www.vm0.ai");
        expect(url.pathname).toBe("/sign-in/tasks/choose-organization");
        expect(url.searchParams.has("domain")).toBeFalsy();
      });
    });
  });
});
