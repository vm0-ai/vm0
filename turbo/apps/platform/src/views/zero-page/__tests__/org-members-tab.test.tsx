import type { OrgMembersResponse } from "@vm0/api-contracts/contracts/org-members";
import {
  zeroOrgInviteContract,
  zeroOrgMembersContract,
  zeroOrgMembershipRequestsContract,
} from "@vm0/api-contracts/contracts/zero-org-members";
import { screen, waitFor, within } from "@testing-library/react";
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
        imageUrl: "",
        role: "member",
        joinedAt: "2026-01-02T00:00:00Z",
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

describe("organization members settings", () => {
  it("filters members, sends an invitation, and accepts a join request", async () => {
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

    await fill(screen.getByPlaceholderText("Search"), "carol");
    await waitFor(() => {
      expect(screen.getByText("Carol Request")).toBeInTheDocument();
      expect(screen.getByText("Request")).toBeInTheDocument();
    });

    click(screen.getByTitle("Accept request"));

    await waitFor(() => {
      expect(screen.getByText("Carol Request")).toBeInTheDocument();
      expect(screen.queryByText("Request")).not.toBeInTheDocument();
    });
    expect(screen.getByText("carol@example.com")).toBeInTheDocument();
  });
});
