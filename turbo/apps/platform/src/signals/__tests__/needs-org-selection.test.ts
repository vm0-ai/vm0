import { describe, it, expect } from "vitest";
import { FeatureSwitchKey } from "@vm0/core";
import { testContext } from "./test-helpers.ts";
import { setupPage } from "../../__tests__/page-helper.ts";
import { mockOrganization } from "../../__tests__/mock-auth.ts";
import { pathname$ } from "../route.ts";

const context = testContext();

describe("org selection after auth", () => {
  describe("when Zero feature flag is disabled", () => {
    it("does not redirect even with multiple orgs", async () => {
      await setupPage({
        context,
        path: "/",
        withoutRender: true,
        featureSwitches: { [FeatureSwitchKey.Zero]: false },
      });
      mockOrganization({
        memberships: [{ id: "org_1" }, { id: "org_2" }],
      });

      expect(context.store.get(pathname$)).not.toBe("/select-org");
    });
  });

  describe("when Zero feature flag is enabled", () => {
    it("redirects to /select-org when user has multiple orgs and no active org", async () => {
      mockOrganization({
        activeOrg: null,
        memberships: [{ id: "org_1" }, { id: "org_2" }],
      });

      await setupPage({
        context,
        path: "/",
        withoutRender: true,
        featureSwitches: { [FeatureSwitchKey.Zero]: true },
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
        featureSwitches: { [FeatureSwitchKey.Zero]: true },
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
        featureSwitches: { [FeatureSwitchKey.Zero]: true },
      });

      // Zero enabled → home page redirects to /zero
      expect(context.store.get(pathname$)).toBe("/zero");
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
        featureSwitches: { [FeatureSwitchKey.Zero]: true },
      });

      // Should go to /zero (normal Zero flow), not /select-org
      expect(context.store.get(pathname$)).toBe("/zero");
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
        featureSwitches: { [FeatureSwitchKey.Zero]: true },
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
        featureSwitches: { [FeatureSwitchKey.Zero]: true },
      });

      // Should go to /zero (normal flow), not /select-org
      expect(context.store.get(pathname$)).toBe("/zero");
    });
  });
});
