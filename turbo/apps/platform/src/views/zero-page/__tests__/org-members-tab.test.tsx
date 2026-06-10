import type { OrgMembersResponse } from "@vm0/api-contracts/contracts/org-members";
import {
  zeroOrgInviteContract,
  zeroOrgMembersContract,
  zeroOrgMembershipRequestsContract,
} from "@vm0/api-contracts/contracts/zero-org-members";
import { screen, waitFor, within } from "@testing-library/react";
import { toast } from "@vm0/ui/components/ui/sonner";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function buttonByText(
  text: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
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

function mockMembersStory(): void {
  let response: OrgMembersResponse = {
    slug: "test-org",
    role: "admin",
    createdAt: "2026-01-01T00:00:00Z",
    members: [
      {
        userId: "test-user-123",
        email: "alice@example.com",
        firstName: "Alice",
        lastName: "Admin",
        imageUrl: "",
        role: "admin",
        joinedAt: "2026-01-01T00:00:00Z",
      },
      {
        userId: "user-bob",
        email: "bob@example.com",
        firstName: "Bob",
        lastName: "Member",
        imageUrl: "https://example.test/bob.png",
        role: "member",
        joinedAt: "2026-01-02T00:00:00Z",
      },
      {
        userId: "user-eve",
        email: "eve@example.com",
        firstName: "Eve",
        lastName: "Admin",
        imageUrl: "",
        role: "admin",
        joinedAt: "2026-01-02T12:00:00Z",
      },
    ],
    pendingInvitations: [
      {
        id: "inv-pending",
        email: "pending@example.com",
        role: "member",
        createdAt: "2026-01-03T00:00:00Z",
      },
    ],
    membershipRequests: [
      {
        id: "req-carol",
        userId: "user-carol",
        email: "carol@example.com",
        firstName: "Carol",
        lastName: "Request",
        imageUrl: "",
        createdAt: "2026-01-04T00:00:00Z",
      },
      {
        id: "req-dan",
        userId: "user-dan",
        email: "dan@example.com",
        firstName: "Dan",
        lastName: "Reject",
        imageUrl: "",
        createdAt: "2026-01-05T00:00:00Z",
      },
    ],
  };

  context.mocks.data.org({
    id: "org_1",
    slug: "test-org",
    name: "Test Org",
    role: "admin",
  });
  context.mocks.api(zeroOrgMembersContract.members, ({ respond }) => {
    return respond(200, response);
  });
  context.mocks.api(zeroOrgInviteContract.invite, ({ body, respond }) => {
    response = {
      ...response,
      pendingInvitations: [
        ...(response.pendingInvitations ?? []),
        {
          id: "inv-new",
          email: body.email,
          role: body.role,
          createdAt: "2026-01-05T00:00:00Z",
        },
      ],
    };
    return respond(200, { message: "Invitation sent" });
  });
  context.mocks.api(zeroOrgInviteContract.revoke, ({ body, respond }) => {
    response = {
      ...response,
      pendingInvitations: response.pendingInvitations?.filter((candidate) => {
        return candidate.id !== body.invitationId;
      }),
    };
    return respond(200, { message: "Invitation revoked" });
  });
  context.mocks.api(zeroOrgMembersContract.updateRole, ({ body, respond }) => {
    response = {
      ...response,
      members: response.members.map((member) => {
        return member.email === body.email
          ? { ...member, role: body.role }
          : member;
      }),
    };
    return respond(200, { message: "Role updated" });
  });
  context.mocks.api(
    zeroOrgMembersContract.removeMember,
    ({ body, respond }) => {
      response = {
        ...response,
        members: response.members.filter((member) => {
          return member.email !== body.email;
        }),
      };
      return respond(200, { message: "Member removed" });
    },
  );
  context.mocks.api(
    zeroOrgMembershipRequestsContract.accept,
    ({ body, respond }) => {
      const request = response.membershipRequests?.find((candidate) => {
        return candidate.id === body.requestId;
      });
      response = {
        ...response,
        membershipRequests: response.membershipRequests?.filter((candidate) => {
          return candidate.id !== body.requestId;
        }),
        members: request
          ? [
              ...response.members,
              {
                userId: request.userId,
                email: request.email,
                firstName: request.firstName,
                lastName: request.lastName,
                imageUrl: request.imageUrl,
                role: "member",
                joinedAt: "2026-01-06T00:00:00Z",
              },
            ]
          : response.members,
      };
      return respond(200, { message: "Request accepted" });
    },
  );
  context.mocks.api(
    zeroOrgMembershipRequestsContract.reject,
    ({ body, respond }) => {
      response = {
        ...response,
        membershipRequests: response.membershipRequests?.filter((candidate) => {
          return candidate.id !== body.requestId;
        }),
      };
      return respond(200, { message: "Request rejected" });
    },
  );
}

async function openMembersTab(): Promise<void> {
  detachedSetupPage({ context, path: "/?settings=people" });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Members" }),
    ).toBeInTheDocument();
  });
}

function rowByEmail(email: string): HTMLElement {
  const row = screen.getByText(email).closest(".grid");
  if (!row) {
    throw new Error(`${email} member row not found`);
  }
  return row as HTMLElement;
}

describe("organization members settings", () => {
  it("filters members and sends an invitation", async () => {
    mockMembersStory();
    await openMembersTab();

    expect(screen.getByText("Alice Admin")).toBeInTheDocument();
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
    expect(screen.getByText("Carol Request")).toBeInTheDocument();

    await fill(screen.getByPlaceholderText("Search"), "bob");
    await waitFor(() => {
      expect(screen.getByText("bob@example.com")).toBeInTheDocument();
      expect(screen.queryByText("Alice Admin")).not.toBeInTheDocument();
    });

    click(buttonByText("Add member"));
    const inviteDialog = await screen.findByRole("dialog", {
      name: "Invite member",
    });
    await fill(
      within(inviteDialog).getByPlaceholderText("email@example.com"),
      "bob.invited@example.com",
    );
    click(buttonByText("Send invitation", inviteDialog));

    await waitFor(() => {
      expect(screen.getByText("bob.invited@example.com")).toBeInTheDocument();
    });
  });

  it("accepts and rejects membership requests", async () => {
    mockMembersStory();
    await openMembersTab();

    await fill(screen.getByPlaceholderText("Search"), "carol");
    await waitFor(() => {
      expect(screen.getByText("Carol Request")).toBeInTheDocument();
      expect(screen.getAllByText("Request")).toHaveLength(2);
    });

    click(screen.getAllByTitle("Accept request")[0]!);

    await waitFor(() => {
      expect(screen.getByText("Carol Request")).toBeInTheDocument();
      expect(screen.getByText("Dan Reject")).toBeInTheDocument();
      expect(screen.getAllByText("Request")).toHaveLength(1);
    });
    expect(screen.getByText("carol@example.com")).toBeInTheDocument();

    await fill(screen.getByPlaceholderText("Search"), "dan");
    await waitFor(() => {
      expect(screen.getByText("Dan Reject")).toBeInTheDocument();
      expect(screen.getByText("Request")).toBeInTheDocument();
    });

    click(screen.getByTitle("Reject request"));

    await waitFor(() => {
      expect(
        screen.getByText("Membership request rejected"),
      ).toBeInTheDocument();
      expect(screen.queryByText("Dan Reject")).not.toBeInTheDocument();
      expect(screen.queryByText("dan@example.com")).not.toBeInTheDocument();
    });
    toast.dismiss();
    await waitFor(() => {
      expect(
        screen.queryByText("Membership request rejected"),
      ).not.toBeInTheDocument();
    });
  });

  it("changes roles, removes a member, and lets an admin self-demote", async () => {
    mockMembersStory();
    await openMembersTab();

    click(screen.getByLabelText("Actions for bob@example.com"));
    click(menuItemByText("Make admin"));

    await waitFor(() => {
      expect(
        screen.getByText("Updated role for bob@example.com"),
      ).toBeInTheDocument();
      expect(
        within(rowByEmail("bob@example.com")).getByText("Admin"),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Actions for bob@example.com"));
    click(menuItemByText("Remove from org"));

    const removeDialog = await screen.findByRole("dialog", {
      name: "Remove member?",
    });
    expect(
      within(removeDialog).getByText(/lose access to all resources/u),
    ).toBeInTheDocument();
    click(buttonByText("Remove", removeDialog));

    await waitFor(() => {
      expect(screen.getByText("Removed bob@example.com")).toBeInTheDocument();
      expect(screen.queryByText("bob@example.com")).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Actions for alice@example.com"));
    click(menuItemByText("Switch to member"));

    const selfDemoteDialog = await screen.findByRole("dialog", {
      name: "Switch to member?",
    });
    expect(
      within(selfDemoteDialog).getByText(/lose admin privileges/u),
    ).toBeInTheDocument();
    click(buttonByText("Confirm", selfDemoteDialog));

    await waitFor(() => {
      expect(
        screen.getByText("Updated role for alice@example.com"),
      ).toBeInTheDocument();
      expect(
        within(rowByEmail("alice@example.com")).getByText("Member"),
      ).toBeInTheDocument();
      expect(
        screen.queryByLabelText("Actions for alice@example.com"),
      ).not.toBeInTheDocument();
    });
  });

  it("cancels and confirms invitation revoke", async () => {
    mockMembersStory();
    await openMembersTab();

    await fill(screen.getByPlaceholderText("Search"), "pending");
    await waitFor(() => {
      expect(screen.getByText("pending@example.com")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Actions for pending@example.com"));
    click(menuItemByText("Revoke invitation"));

    const cancelRevokeDialog = await screen.findByRole("dialog", {
      name: "Revoke invitation?",
    });
    expect(
      within(cancelRevokeDialog).getByText(
        /will no longer be able to join using this invitation/i,
      ),
    ).toBeInTheDocument();
    click(buttonByText("Cancel", cancelRevokeDialog));

    await waitFor(() => {
      expect(screen.getByText("pending@example.com")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Actions for pending@example.com"));
    click(menuItemByText("Revoke invitation"));

    const revokeDialog = await screen.findByRole("dialog", {
      name: "Revoke invitation?",
    });
    click(buttonByText("Revoke", revokeDialog));

    await waitFor(() => {
      expect(screen.getByText("Invitation revoked")).toBeInTheDocument();
      expect(screen.queryByText("pending@example.com")).not.toBeInTheDocument();
    });
  });
});
