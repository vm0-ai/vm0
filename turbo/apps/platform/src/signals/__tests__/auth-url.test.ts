import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../__tests__/page-helper.ts";
import { mockedClerk } from "../../__tests__/mock-auth.ts";
import {
  deriveServiceOrigin,
  getAllowedAuthRedirectOrigins,
  resolveAppAuthUrl,
  resolveClerkSatelliteConfig,
  resolveWebAuthUrl,
  resolveWebOrigin,
} from "../auth.ts";
import { testContext } from "./test-helpers.ts";

const context = testContext();

function setBrowserUrl(url: string): void {
  window.location.href = url;
}

describe("platform auth URLs", () => {
  it("derives the www origin from the current host", () => {
    setBrowserUrl("https://app.vm7.ai:8443/agents");
    expect(resolveWebOrigin()).toBe("https://www.vm7.ai:8443");

    setBrowserUrl("https://pr-18532-app.omby.ai/agents");
    expect(resolveWebOrigin()).toBe("https://pr-18532-www.omby.ai");

    setBrowserUrl("https://app.vm0.ai/agents");
    expect(resolveWebOrigin()).toBe("https://www.vm0.ai");
  });

  it("derives sibling service origins keeping protocol and port", () => {
    expect(deriveServiceOrigin("https://app.vm7.ai:8443", "api")).toBe(
      "https://api.vm7.ai:8443",
    );
    expect(deriveServiceOrigin("https://staging-app.omby.ai", "www")).toBe(
      "https://staging-www.omby.ai",
    );
    expect(deriveServiceOrigin("https://pr-18532-app.omby.ai", "api")).toBe(
      "https://pr-18532-api.vm6.ai",
    );
  });

  it("builds app auth URLs on the current origin without a domain hint", () => {
    setBrowserUrl("https://pr-18532-app.omby.ai/agents");

    const signInUrl = new URL(resolveAppAuthUrl("/sign-in"));
    expect(signInUrl.origin).toBe("https://pr-18532-app.omby.ai");
    expect(signInUrl.pathname).toBe("/sign-in");
    expect(signInUrl.searchParams.has("domain")).toBeFalsy();

    const redirectUrl = new URL(
      resolveAppAuthUrl("/sign-in", {
        redirectUrl: "https://pr-18532-app.omby.ai/",
      }),
    );
    expect(redirectUrl.searchParams.get("redirect_url")).toBe(
      "https://pr-18532-app.omby.ai/",
    );
    expect(redirectUrl.searchParams.has("domain")).toBeFalsy();
  });

  it("builds web auth URLs on the derived www origin", () => {
    setBrowserUrl("https://app.vm7.ai:8443/agents");

    const signInUrl = new URL(resolveWebAuthUrl("/sign-in"));
    expect(signInUrl.origin).toBe("https://www.vm7.ai:8443");
    expect(signInUrl.pathname).toBe("/sign-in");
    expect(signInUrl.searchParams.has("domain")).toBeFalsy();
  });

  it("uses app auth in production without extra params", () => {
    setBrowserUrl("https://app.vm0.ai/agents");

    expect(resolveAppAuthUrl("/sign-in")).toBe("https://app.vm0.ai/sign-in");
    expect(resolveClerkSatelliteConfig()).toBeNull();
    const allowedOrigins = getAllowedAuthRedirectOrigins();
    expect(
      allowedOrigins.filter((origin) => {
        return typeof origin === "string";
      }),
    ).toStrictEqual([
      "https://app.vm0.ai",
      "https://www.vm0.ai",
      "https://api.vm0.ai",
    ]);
    expect(
      allowedOrigins.some((origin) => {
        return origin instanceof RegExp && origin.test("https://app.okou.ai");
      }),
    ).toBeTruthy();
    expect(
      allowedOrigins.some((origin) => {
        return (
          origin instanceof RegExp &&
          origin.test("https://okou.ai.evil.example")
        );
      }),
    ).toBeFalsy();
  });

  it("uses primary app auth for the configured production satellite", () => {
    setBrowserUrl("https://app.okou.ai/agents");

    expect(resolveAppAuthUrl("/sign-in")).toBe("https://app.vm0.ai/sign-in");
    expect(resolveClerkSatelliteConfig()).toStrictEqual({
      domain: "app.okou.ai",
      isSatellite: true,
      satelliteAutoSync: true,
    });
    const allowedOrigins = getAllowedAuthRedirectOrigins();
    expect(
      allowedOrigins.filter((origin) => {
        return typeof origin === "string";
      }),
    ).toStrictEqual([
      "https://app.okou.ai",
      "https://www.vm0.ai",
      "https://api.vm0.ai",
      "https://app.vm0.ai",
    ]);
    expect(
      allowedOrigins.some((origin) => {
        return origin instanceof RegExp && origin.test("https://app.okou.ai");
      }),
    ).toBeTruthy();
  });

  it("uses the registered satellite config on its subdomains", () => {
    setBrowserUrl("https://console.app.okou.ai/agents");

    expect(resolveAppAuthUrl("/sign-in")).toBe("https://app.vm0.ai/sign-in");
    expect(resolveClerkSatelliteConfig()).toStrictEqual({
      domain: "app.okou.ai",
      isSatellite: true,
      satelliteAutoSync: true,
    });
  });

  it("does not enable satellite mode on an unregistered okou.ai sibling", () => {
    setBrowserUrl("https://console.okou.ai/agents");

    expect(resolveAppAuthUrl("/sign-in")).toBe(
      "https://console.okou.ai/sign-in",
    );
    expect(resolveClerkSatelliteConfig()).toBeNull();
  });
});

describe("platform auth redirects", () => {
  it("redirects unauthenticated users to app auth on the current origin", async () => {
    setBrowserUrl("https://pr-18532-app.omby.ai/agents");

    detachedSetupPage({
      context,
      path: "/agents",
      session: null,
      user: null,
    });

    await waitFor(() => {
      const url = new URL(window.location.href);
      expect(url.origin).toBe("https://pr-18532-app.omby.ai");
      expect(url.pathname).toBe("/sign-in");
      expect(url.searchParams.has("domain")).toBeFalsy();
      expect(url.searchParams.get("redirect_url")).toBe(
        "https://pr-18532-app.omby.ai/agents",
      );
    });
  });

  it("redirects users who need org selection to app auth", async () => {
    setBrowserUrl("https://pr-18532-app.omby.ai/agents");

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
      expect(url.origin).toBe("https://pr-18532-app.omby.ai");
      expect(url.pathname).toBe("/sign-in/tasks/choose-organization");
      expect(url.searchParams.has("domain")).toBeFalsy();
    });
  });

  it("uses app auth for non-preview org selection", async () => {
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

    expect(mockedClerk.initialize).toHaveBeenCalledWith("test_production_key");
    expect(mockedClerk.load).toHaveBeenCalledWith(
      expect.objectContaining({
        afterSignOutUrl: "https://app.vm0.ai/sign-in",
        signInUrl: "https://app.vm0.ai/sign-in",
        signUpUrl: "https://app.vm0.ai/sign-up",
        ui: expect.objectContaining({
          ClerkUI: expect.any(Function),
          version: "1.26.0",
        }),
      }),
    );
  });

  it("redirects an unauthenticated satellite user through primary auth", async () => {
    setBrowserUrl("https://app.okou.ai/agents?utm_source=okou-launch");

    detachedSetupPage({
      context,
      path: "/agents",
      session: null,
      user: null,
    });

    await waitFor(() => {
      const url = new URL(window.location.href);
      expect(url.origin).toBe("https://app.vm0.ai");
      expect(url.pathname).toBe("/sign-in");
      expect(url.searchParams.get("redirect_url")).toBe(
        "https://app.okou.ai/agents?utm_source=okou-launch",
      );
    });

    expect(mockedClerk.initialize).toHaveBeenCalledWith("test_production_key", {
      domain: "app.okou.ai",
    });
    expect(mockedClerk.load).toHaveBeenCalledWith(
      expect.objectContaining({
        afterSignOutUrl: "https://app.vm0.ai/sign-in",
        isSatellite: true,
        satelliteAutoSync: true,
        signInUrl: "https://app.vm0.ai/sign-in",
        signUpUrl: "https://app.vm0.ai/sign-up",
        ui: expect.objectContaining({
          ClerkUI: expect.any(Function),
          version: "1.26.0",
        }),
      }),
    );
  });
});
