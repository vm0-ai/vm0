import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../__tests__/page-helper.ts";
import {
  deriveServiceOrigin,
  resolveAppAuthUrl,
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

    setBrowserUrl("https://pr-18532-app.vm6.ai/agents");
    expect(resolveWebOrigin()).toBe("https://pr-18532-www.vm6.ai");

    setBrowserUrl("https://app.vm0.ai/agents");
    expect(resolveWebOrigin()).toBe("https://www.vm0.ai");
  });

  it("derives sibling service origins keeping protocol and port", () => {
    expect(deriveServiceOrigin("https://app.vm7.ai:8443", "api")).toBe(
      "https://api.vm7.ai:8443",
    );
    expect(deriveServiceOrigin("https://staging-app.vm6.ai", "www")).toBe(
      "https://staging-www.vm6.ai",
    );
    expect(deriveServiceOrigin("https://pr-18532-app.vm6.ai", "api")).toBe(
      "https://pr-18532-api.vm6.ai",
    );
  });

  it("builds app auth URLs on the current origin without a domain hint", () => {
    setBrowserUrl("https://pr-18532-app.vm6.ai/agents");

    const signInUrl = new URL(resolveAppAuthUrl("/sign-in"));
    expect(signInUrl.origin).toBe("https://pr-18532-app.vm6.ai");
    expect(signInUrl.pathname).toBe("/sign-in");
    expect(signInUrl.searchParams.has("domain")).toBeFalsy();

    const redirectUrl = new URL(
      resolveAppAuthUrl("/sign-in", {
        redirectUrl: "https://pr-18532-app.vm6.ai/",
      }),
    );
    expect(redirectUrl.searchParams.get("redirect_url")).toBe(
      "https://pr-18532-app.vm6.ai/",
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
  });
});

describe("platform auth redirects", () => {
  it("redirects unauthenticated users to app auth on the current origin", async () => {
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
      expect(url.searchParams.has("domain")).toBeFalsy();
      expect(url.searchParams.get("redirect_url")).toBe(
        "https://pr-18532-app.vm6.ai/agents",
      );
    });
  });

  it("redirects users who need org selection to app auth", async () => {
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
  });
});
