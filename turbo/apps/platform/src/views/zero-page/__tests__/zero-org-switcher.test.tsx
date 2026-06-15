import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function buttonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

function menuItemByText(text: string): HTMLElement {
  const item = queryAllByRoleFast("menuitem").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!item) {
    throw new Error(`${text} menu item not found`);
  }
  return item;
}

describe("zero org switcher", () => {
  it("shows pending workspace invitations and other workspaces from the sidebar menu", async () => {
    const acceptDeferred = context.mocks.deferred<void>();
    const pendingInvitations = [
      {
        id: "invitation_1",
        publicOrganizationData: {
          id: "org_invited",
          name: "Invited Org",
          imageUrl: "https://cdn.vm0.test/orgs/invited.png",
        },
        accept: async () => {
          await acceptDeferred.promise;
          pendingInvitations.length = 0;
        },
      },
    ];

    context.mocks.data.org({
      id: "org_current",
      name: "Acme",
      slug: "acme",
      role: "admin",
    });

    detachedSetupPage({
      context,
      path: "/",
      org: {
        activeOrg: {
          id: "org_current",
          name: "Acme",
          slug: "acme",
          imageUrl: "https://cdn.vm0.test/orgs/acme.png",
          hasImage: true,
        },
        memberships: [
          {
            id: "membership_current",
            organization: {
              id: "org_current",
              name: "Acme",
              imageUrl: "https://cdn.vm0.test/orgs/acme.png",
            },
          },
          {
            id: "membership_design",
            organization: {
              id: "org_design",
              name: "Design Org",
              imageUrl: "https://cdn.vm0.test/orgs/design.png",
            },
          },
        ],
        pendingInvitations,
      },
    });

    const orgSwitcher = await waitFor(() => {
      expect(screen.getByText("Acme")).toBeInTheDocument();
      expect(
        screen.getByTestId("pending-invitations-badge"),
      ).toBeInTheDocument();
      return buttonByText("Acme");
    });

    click(orgSwitcher);

    await waitFor(() => {
      expect(screen.getByText("Design Org")).toBeInTheDocument();
      expect(screen.getByText("Invited Org")).toBeInTheDocument();
      expect(screen.getByRole("img", { name: "Design Org" })).toHaveAttribute(
        "src",
        "https://cdn.vm0.test/orgs/design.png",
      );
      expect(screen.getByRole("img", { name: "Invited Org" })).toHaveAttribute(
        "src",
        "https://cdn.vm0.test/orgs/invited.png",
      );
    });

    click(buttonByText("Join"));

    await waitFor(() => {
      expect(screen.getByText("Joining…")).toBeInTheDocument();
    });

    acceptDeferred.resolve();

    await waitFor(() => {
      expect(screen.queryByText("Invited Org")).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("pending-invitations-badge"),
      ).not.toBeInTheDocument();
      expect(screen.getByText("Design Org")).toBeInTheDocument();
    });

    click(menuItemByText("Design Org"));

    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
  });

  it("creates a new workspace from the org switcher menu", async () => {
    context.mocks.data.org({
      id: "org_current",
      name: "Solo",
      slug: "solo",
      role: "admin",
    });

    detachedSetupPage({
      context,
      path: "/",
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
        createOrganizationEnabled: true,
      },
      org: {
        activeOrg: {
          id: "org_current",
          name: "Solo",
          slug: "solo",
        },
        memberships: [
          {
            id: "membership_current",
            organization: {
              id: "org_current",
              name: "Solo",
            },
          },
        ],
      },
    });

    const orgSwitcher = await waitFor(() => {
      const label = screen.getByText("Solo");
      const trigger = label.closest("button");
      if (!trigger) {
        throw new Error("Org switcher trigger not found");
      }
      return trigger;
    });

    click(orgSwitcher);

    await waitFor(() => {
      expect(screen.getByText("Create workspace")).toBeInTheDocument();
    });

    click(screen.getByText("Create workspace"));

    await waitFor(() => {
      expect(mockedClerk.createOrganization).toHaveBeenCalledWith({
        name: expect.stringMatching(/^workspace-/u),
        slug: expect.stringMatching(/^workspace-/u),
      });
      expect(mockedClerk.setActive).toHaveBeenCalledWith({
        organization: "new-org-id",
      });
    });
  });
});
