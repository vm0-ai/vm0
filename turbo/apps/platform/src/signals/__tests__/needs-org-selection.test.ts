import { describe, it, expect } from "vitest";
import { testContext } from "./test-helpers.ts";
import { setupPage } from "../../__tests__/page-helper.ts";
import { pathname$ } from "../route.ts";

const context = testContext();

describe("org selection after auth", () => {
  it("redirects to /select-org when user has multiple orgs and no active org", async () => {
    await setupPage({
      context,
      path: "/",
      org: {
        activeOrg: null,
        memberships: [{ id: "org_1" }, { id: "org_2" }],
      },
      withoutRender: true,
    });

    expect(context.store.get(pathname$)).toBe("/select-org");
  });

  it("redirects to /select-org when user has pending invitations and no active org", async () => {
    await setupPage({
      context,
      path: "/",
      org: {
        activeOrg: null,
        memberships: [{ id: "org_1" }],
      },
      withoutRender: true,
    });

    expect(context.store.get(pathname$)).toBe("/select-org");
  });

  it("redirects to /select-org when user has single org but no active org", async () => {
    await setupPage({
      context,
      path: "/",
      org: {
        activeOrg: null,
        memberships: [{ id: "org_1" }],
      },
      withoutRender: true,
    });

    expect(context.store.get(pathname$)).toBe("/select-org");
  });

  it("does not redirect when active org is already set", async () => {
    await setupPage({
      context,
      path: "/",
      org: {
        activeOrg: { id: "org_1", name: "My Org" },
        memberships: [{ id: "org_1" }, { id: "org_2" }],
      },
      withoutRender: true,
    });

    // Should not redirect to /select-org (normal flow)
    expect(context.store.get(pathname$)).not.toBe("/select-org");
  });

  it("does not redirect when already on /select-org", async () => {
    await setupPage({
      context,
      path: "/select-org",
      org: {
        activeOrg: null,
        memberships: [{ id: "org_1" }, { id: "org_2" }],
      },
      withoutRender: true,
    });

    // Should stay on /select-org, not redirect in a loop
    expect(context.store.get(pathname$)).toBe("/select-org");
  });

  it("redirects to /select-org when user has no orgs", async () => {
    await setupPage({
      context,
      path: "/",
      org: {
        activeOrg: null,
        memberships: [],
      },
      withoutRender: true,
    });

    expect(context.store.get(pathname$)).toBe("/select-org");
  });
});
