import { describe, it, expect } from "vitest";
import { testContext } from "./test-helpers.ts";
import { setupPage } from "../../__tests__/page-helper.ts";
import { mockOrganization } from "../../__tests__/mock-auth.ts";
import { pathname$ } from "../route.ts";

const context = testContext();

describe("org selection after auth", () => {
  it("redirects to /select-org when user has multiple orgs and no active org", async () => {
    mockOrganization({
      activeOrg: null,
      memberships: [{ id: "org_1" }, { id: "org_2" }],
    });

    await setupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    expect(context.store.get(pathname$)).toBe("/select-org");
  });

  it("redirects to /select-org when user has pending invitations and no active org", async () => {
    mockOrganization({
      activeOrg: null,
      memberships: [{ id: "org_1" }],
      pendingInvitations: [{ id: "inv_1" }],
    });

    await setupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    expect(context.store.get(pathname$)).toBe("/select-org");
  });

  it("does not redirect when user has single org and no invitations", async () => {
    mockOrganization({
      activeOrg: null,
      memberships: [{ id: "org_1" }],
      pendingInvitations: [],
    });

    await setupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    // Home redirects to /talk/:name, not /select-org
    expect(context.store.get(pathname$)).not.toBe("/select-org");
  });

  it("does not redirect when active org is already set", async () => {
    mockOrganization({
      activeOrg: { id: "org_1", name: "My Org" },
      memberships: [{ id: "org_1" }, { id: "org_2" }],
    });

    await setupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    // Should not redirect to /select-org (normal flow)
    expect(context.store.get(pathname$)).not.toBe("/select-org");
  });

  it("does not redirect when already on /select-org", async () => {
    mockOrganization({
      activeOrg: null,
      memberships: [{ id: "org_1" }, { id: "org_2" }],
    });

    await setupPage({
      context,
      path: "/select-org",
      withoutRender: true,
    });

    // Should stay on /select-org, not redirect in a loop
    expect(context.store.get(pathname$)).toBe("/select-org");
  });

  it("does not redirect when user has no orgs", async () => {
    mockOrganization({
      activeOrg: null,
      memberships: [],
      pendingInvitations: [],
    });

    await setupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    // Should not redirect to /select-org (normal flow)
    expect(context.store.get(pathname$)).not.toBe("/select-org");
  });
});
