import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../__tests__/page-helper.ts";
import { resolveWebAuthUrl, resolveWebOrigin } from "../auth.ts";
import { testContext } from "./test-helpers.ts";

const context = testContext();

function setBrowserUrl(url: string): void {
  window.location.href = url;
}

describe("platform auth URLs", () => {
  it("derives the web origin from the app origin", () => {
    setBrowserUrl("https://pr-18532-app.vm6.ai/agents");

    expect(resolveWebOrigin()).toBe("https://pr-18532-www.vm6.ai");
  });

  it("adds the PR API domain override to vm6 auth URLs", () => {
    setBrowserUrl("https://pr-18532-app.vm6.ai/agents");

    expect(resolveWebAuthUrl("/sign-in")).toBe(
      "https://pr-18532-www.vm6.ai/sign-in?domain=pr-18532-api.vm6.ai",
    );
    expect(resolveWebAuthUrl("/sign-in/tasks/choose-organization")).toBe(
      "https://pr-18532-www.vm6.ai/sign-in/tasks/choose-organization?domain=pr-18532-api.vm6.ai",
    );
    expect(
      resolveWebAuthUrl("/sign-in", {
        redirectUrl: "https://pr-18532-app.vm6.ai/",
      }),
    ).toBe(
      "https://pr-18532-www.vm6.ai/sign-in?domain=pr-18532-api.vm6.ai&redirect_url=https%3A%2F%2Fpr-18532-app.vm6.ai%2F",
    );
  });

  it("does not add a domain override outside vm6 preview origins", () => {
    setBrowserUrl("https://app.vm0.ai/agents");

    expect(resolveWebAuthUrl("/sign-in")).toBe("https://www.vm0.ai/sign-in");
  });
});

describe("platform auth redirects", () => {
  it("redirects unauthenticated preview users to web sign-in with API domain override", async () => {
    setBrowserUrl("https://pr-18532-app.vm6.ai/agents");

    detachedSetupPage({
      context,
      path: "/agents",
      session: null,
      user: null,
    });

    await waitFor(() => {
      const url = new URL(window.location.href);
      expect(url.origin).toBe("https://pr-18532-www.vm6.ai");
      expect(url.pathname).toBe("/sign-in");
      expect(url.searchParams.get("domain")).toBe("pr-18532-api.vm6.ai");
      expect(url.searchParams.get("redirect_url")).toBe(
        "https://pr-18532-app.vm6.ai/agents",
      );
    });
  });

  it("redirects preview users who need org selection with API domain override", async () => {
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
      expect(url.origin).toBe("https://pr-18532-www.vm6.ai");
      expect(url.pathname).toBe("/sign-in/tasks/choose-organization");
      expect(url.searchParams.get("domain")).toBe("pr-18532-api.vm6.ai");
    });
  });

  it("redirects non-preview org selection without an API domain override", async () => {
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
