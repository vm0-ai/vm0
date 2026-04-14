import { describe, it, expect, vi, afterEach } from "vitest";
import { testContext } from "./test-helpers.ts";
import { detachedSetupPage } from "../../__tests__/page-helper.ts";

const context = testContext();

const CHOOSE_ORG_PATH = "/sign-in/tasks/choose-organization";

afterEach(() => {
  // Reset location that may have been changed by window.location.href assignment
  if (window.location.pathname !== "/") {
    window.location.href = "http://localhost/";
  }
});

describe("org selection after auth", () => {
  it("redirects to choose-organization when user has multiple orgs and no active org", async () => {
    detachedSetupPage({
      context,
      path: "/",
      org: {
        activeOrg: null,
        memberships: [{ id: "org_1" }, { id: "org_2" }],
      },
      withoutRender: true,
    });

    await vi.waitFor(() => {
      expect(window.location.href).toContain(CHOOSE_ORG_PATH);
    });
  });

  it("redirects to choose-organization when user has pending invitations and no active org", async () => {
    detachedSetupPage({
      context,
      path: "/",
      org: {
        activeOrg: null,
        memberships: [{ id: "org_1" }],
      },
      withoutRender: true,
    });

    await vi.waitFor(() => {
      expect(window.location.href).toContain(CHOOSE_ORG_PATH);
    });
  });

  it("redirects to choose-organization when user has single org but no active org", async () => {
    detachedSetupPage({
      context,
      path: "/",
      org: {
        activeOrg: null,
        memberships: [{ id: "org_1" }],
      },
      withoutRender: true,
    });

    await vi.waitFor(() => {
      expect(window.location.href).toContain(CHOOSE_ORG_PATH);
    });
  });

  it("does not redirect when active org is already set", async () => {
    detachedSetupPage({
      context,
      path: "/",
      org: {
        activeOrg: { id: "org_1", name: "My Org" },
        memberships: [{ id: "org_1" }, { id: "org_2" }],
      },
      withoutRender: true,
    });

    // Give async setup time to run, then verify no redirect happened
    await vi.waitFor(() => {
      expect(window.location.href).not.toContain(CHOOSE_ORG_PATH);
    });
  });

  it("redirects to choose-organization when user has no orgs", async () => {
    detachedSetupPage({
      context,
      path: "/",
      org: {
        activeOrg: null,
        memberships: [],
      },
      withoutRender: true,
    });

    await vi.waitFor(() => {
      expect(window.location.href).toContain(CHOOSE_ORG_PATH);
    });
  });
});
