import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { click, detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { search } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function base64Url(value: object): string {
  return btoa(JSON.stringify(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function invitationPath(organizationId: string): string {
  const ticket = `${base64Url({ alg: "RS256", typ: "JWT" })}.${base64Url({
    oid: organizationId,
    st: "organization_invitation",
  })}.test-signature`;
  const searchParams = new URLSearchParams({
    __clerk_status: "complete",
    __clerk_ticket: ticket,
    source: "invitation-test",
  });
  return `/?${searchParams.toString()}`;
}

describe("organization invitation redirect toast", () => {
  it("offers to switch workspaces when the current account accepted the invitation", async () => {
    detachedSetupPage({
      context,
      path: invitationPath("org_invited"),
      user: {
        id: "user_invited",
        fullName: "Invited User",
        email: "invited@example.test",
      },
      org: {
        activeOrg: { id: "org_current", name: "Current Workspace" },
        memberships: [
          {
            id: "orgmem_current",
            organization: { id: "org_current", name: "Current Workspace" },
          },
          {
            id: "orgmem_invited",
            organization: {
              id: "org_invited",
              name: "Invited Workspace",
            },
          },
        ],
      },
    });

    await waitFor(() => {
      const searchParams = new URLSearchParams(search());
      expect(searchParams.has("__clerk_status")).toBeFalsy();
      expect(searchParams.has("__clerk_ticket")).toBeFalsy();
      expect(searchParams.get("source")).toBe("invitation-test");
    });
    const successTitle = await screen.findByText(
      "Invitation accepted for Invited Workspace",
    );
    expect(successTitle).toBeInTheDocument();
    expect(
      screen.getByText("Switch workspace", {
        selector: "button[data-action]",
      }),
    ).toBeInTheDocument();
  });

  it("offers to switch accounts when the active account is not the invitee", async () => {
    detachedSetupPage({
      context,
      path: invitationPath("org_invited"),
      user: {
        id: "user_current",
        fullName: "Current User",
        email: "current@example.test",
      },
      org: {
        activeOrg: { id: "org_current", name: "Current Workspace" },
        memberships: [
          {
            id: "orgmem_current",
            organization: { id: "org_current", name: "Current Workspace" },
          },
        ],
      },
    });

    await waitFor(() => {
      const searchParams = new URLSearchParams(search());
      expect(searchParams.has("__clerk_status")).toBeFalsy();
      expect(searchParams.has("__clerk_ticket")).toBeFalsy();
    });
    const mismatchTitle = await screen.findByText(
      "Invitation accepted for another account",
    );
    expect(mismatchTitle).toBeInTheDocument();
    click(
      screen.getByText("Switch account", {
        selector: "button[data-action]",
      }),
    );

    const dialog = await screen.findByTestId("auth-v2-add-account-dialog");
    expect(within(dialog).getByTestId("app-auth-v2")).toBeVisible();
    await expect(
      within(dialog).findByLabelText("Email address"),
    ).resolves.toBeVisible();
  });

  it("leaves unfinished Clerk invitation redirects untouched", async () => {
    detachedSetupPage({
      context,
      path: invitationPath("org_invited").replace(
        "__clerk_status=complete",
        "__clerk_status=sign_in",
      ),
    });

    await waitFor(() => {
      const searchParams = new URLSearchParams(search());
      expect(searchParams.get("__clerk_status")).toBe("sign_in");
      expect(searchParams.has("__clerk_ticket")).toBeTruthy();
    });
    expect(screen.queryByText("Invitation accepted")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Invitation accepted for another account"),
    ).not.toBeInTheDocument();
  });
});
