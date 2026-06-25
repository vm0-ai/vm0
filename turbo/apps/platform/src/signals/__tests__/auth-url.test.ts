import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../__tests__/page-helper.ts";
import { testContext } from "./test-helpers.ts";

const context = testContext();

function setBrowserUrl(url: string): void {
  window.location.href = url;
}

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
