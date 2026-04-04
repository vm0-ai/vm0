import { expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import type {
  OrgMember,
  OrgPendingInvitation,
  OrgMembershipRequest,
} from "../../../signals/external/org-members.ts";

const context = testContext();

const adminMember = {
  userId: "test-user-123",
  email: "admin@example.com",
  firstName: "Admin",
  lastName: "User",
  imageUrl: "",
  role: "admin",
  joinedAt: "2026-01-01T00:00:00Z",
} as const satisfies OrgMember;

const regularMember = {
  userId: "user-member",
  email: "member@example.com",
  firstName: "Regular",
  lastName: "Member",
  imageUrl: "",
  role: "member",
  joinedAt: "2026-02-01T00:00:00Z",
} as const satisfies OrgMember;

const secondAdmin = {
  userId: "user-admin-2",
  email: "admin2@example.com",
  firstName: "Second",
  lastName: "Admin",
  imageUrl: "",
  role: "admin",
  joinedAt: "2026-01-15T00:00:00Z",
} as const satisfies OrgMember;

const memberWithImage = {
  userId: "user-with-img",
  email: "imguser@example.com",
  firstName: "Image",
  lastName: "User",
  imageUrl: "https://example.com/avatar.jpg",
  role: "member",
  joinedAt: "2026-03-01T00:00:00Z",
} as const satisfies OrgMember;

const pendingInvitation = {
  id: "inv-001",
  email: "invited@example.com",
  role: "member",
  createdAt: "2026-03-01T00:00:00Z",
} as const satisfies OrgPendingInvitation;

const membershipRequest = {
  id: "req-001",
  userId: "req-user-001",
  email: "requesting@example.com",
  firstName: "Request",
  lastName: "User",
  imageUrl: "",
  createdAt: "2026-03-05T00:00:00Z",
} as const satisfies OrgMembershipRequest;

function mockMembersAPI(options?: {
  members?: OrgMember[];
  pendingInvitations?: OrgPendingInvitation[];
  membershipRequests?: OrgMembershipRequest[];
}) {
  server.use(
    http.get("*/api/zero/org/members", () => {
      return HttpResponse.json({
        slug: "user-12345678",
        role: "admin",
        members: options?.members ?? [adminMember, regularMember],
        pendingInvitations: options?.pendingInvitations ?? [],
        membershipRequests: options?.membershipRequests ?? [],
        createdAt: "2026-01-01T00:00:00Z",
      });
    }),
    http.get("*/api/zero/org/logo", () => {
      return HttpResponse.json({ logoUrl: null });
    }),
  );
}

async function renderMembersTab() {
  await setupPage({ context, path: "/?settings=members" });
}

// ORG-D-022
test("shows member name, email, join date, and role badge in member row", async () => {
  mockMembersAPI({ members: [regularMember] });
  await renderMembersTab();
  await waitFor(() => {
    expect(screen.getByText("Regular Member")).toBeInTheDocument();
    expect(screen.getByText("member@example.com")).toBeInTheDocument();
    expect(screen.getByText("2/1/2026")).toBeInTheDocument();
    expect(screen.getByText("Member")).toBeInTheDocument();
  });
});

// ORG-D-023
test("shows profile image when available and initial letter fallback when not", async () => {
  mockMembersAPI({ members: [adminMember, memberWithImage] });
  await renderMembersTab();
  await waitFor(() => {
    expect(screen.getByRole("img", { name: "Image User" })).toBeInTheDocument();
  });
  // adminMember has no imageUrl — should show initial letter "A"
  expect(screen.getByText("A")).toBeInTheDocument();
});

// ORG-D-024
test("shows pending invitations with Pending status badge", async () => {
  mockMembersAPI({ pendingInvitations: [pendingInvitation] });
  await renderMembersTab();
  await waitFor(() => {
    expect(screen.getByText("invited@example.com")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
  });
});

// ORG-D-025
test("shows membership requests with Accept and Reject buttons", async () => {
  mockMembersAPI({ membershipRequests: [membershipRequest] });
  await renderMembersTab();
  await waitFor(() => {
    expect(
      screen.getByRole("button", { name: "Accept request" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reject request" }),
    ).toBeInTheDocument();
  });
});

// ORG-D-026
test("shows You badge on the current user row", async () => {
  mockMembersAPI({ members: [adminMember] });
  await renderMembersTab();
  await waitFor(() => {
    expect(screen.getByText("You")).toBeInTheDocument();
  });
});

// ORG-D-027
test("shows loading skeletons while data is loading", async () => {
  server.use(
    http.get("*/api/zero/org/members", () => {
      return new Promise(() => {});
    }),
    http.get("*/api/zero/org/logo", () => {
      return HttpResponse.json({ logoUrl: null });
    }),
  );
  await renderMembersTab();
  const skeletons = document.querySelectorAll(".animate-pulse");
  expect(skeletons.length).toBeGreaterThan(0);
});

// ORG-C-028
test("shows empty state when no members match search", async () => {
  const user = userEvent.setup();
  mockMembersAPI({ members: [regularMember] });
  await renderMembersTab();
  await waitFor(() => {
    expect(screen.getByText("Regular Member")).toBeInTheDocument();
  });
  const searchInput = screen.getByPlaceholderText("Search");
  await user.clear(searchInput);
  await user.type(searchInput, "xyz-no-match");
  await waitFor(() => {
    expect(screen.getByText("No members found")).toBeInTheDocument();
  });
});

// ORG-I-029
test("filters member list when search input is used", async () => {
  const user = userEvent.setup();
  mockMembersAPI({ members: [adminMember, regularMember] });
  await renderMembersTab();
  await waitFor(() => {
    expect(screen.getByText("admin@example.com")).toBeInTheDocument();
    expect(screen.getByText("member@example.com")).toBeInTheDocument();
  });
  const searchInput = screen.getByPlaceholderText("Search");
  await user.clear(searchInput);
  await user.type(searchInput, "admin");
  await waitFor(() => {
    expect(screen.getByText("admin@example.com")).toBeInTheDocument();
    expect(screen.queryByText("member@example.com")).not.toBeInTheDocument();
  });
});

// ORG-I-030
test("opens invite dialog when Add member button is clicked", async () => {
  const user = userEvent.setup();
  mockMembersAPI();
  await renderMembersTab();
  await waitFor(() => {
    expect(screen.getByText("admin@example.com")).toBeInTheDocument();
  });
  await user.click(screen.getByRole("button", { name: /Add member/i }));
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Invite member" }),
    ).toBeInTheDocument();
  });
});

// ORG-I-031
test("accepts email input in invite dialog", async () => {
  const user = userEvent.setup();
  mockMembersAPI();
  await renderMembersTab();
  await waitFor(() => {
    expect(screen.getByText("admin@example.com")).toBeInTheDocument();
  });
  await user.click(screen.getByRole("button", { name: /Add member/i }));
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Invite member" }),
    ).toBeInTheDocument();
  });
  const emailInput = screen.getByPlaceholderText("email@example.com");
  await user.clear(emailInput);
  await user.type(emailInput, "test@invite.com");
  expect(emailInput).toHaveValue("test@invite.com");
});

// ORG-I-032
test("shows Member and Admin role options in invite dialog role dropdown", async () => {
  const user = userEvent.setup();
  mockMembersAPI();
  await renderMembersTab();
  await waitFor(() => {
    expect(screen.getByText("admin@example.com")).toBeInTheDocument();
  });
  await user.click(screen.getByRole("button", { name: /Add member/i }));
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Invite member" }),
    ).toBeInTheDocument();
  });
  await user.click(screen.getByRole("combobox"));
  await waitFor(() => {
    expect(screen.getByRole("option", { name: "Member" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Admin" })).toBeInTheDocument();
  });
});

// ORG-I-033
test("shows Make admin and Remove from org in member action menu", async () => {
  const user = userEvent.setup();
  mockMembersAPI({ members: [adminMember, regularMember] });
  await renderMembersTab();
  await waitFor(() => {
    expect(screen.getByText("member@example.com")).toBeInTheDocument();
  });
  // regularMember row has MemberActions (not the current user)
  const memberRow = screen
    .getByText("Regular Member")
    .closest("[class*=grid]")!;
  const menuButton = memberRow.querySelector("button")!;
  await user.click(menuButton);
  await waitFor(() => {
    expect(screen.getByText("Make admin")).toBeInTheDocument();
    expect(screen.getByText("Remove from org")).toBeInTheDocument();
  });
});

// ORG-I-034
test("shows self-demote confirmation dialog when admin switches to member", async () => {
  const user = userEvent.setup();
  mockMembersAPI({ members: [adminMember, secondAdmin, regularMember] });
  await renderMembersTab();
  await waitFor(() => {
    expect(screen.getByText("You")).toBeInTheDocument();
  });
  const youBadge = screen.getByText("You");
  const adminRow = youBadge.closest("[class*=grid]")!;
  const menuButton = adminRow.querySelector("button")!;
  await user.click(menuButton);
  await waitFor(() => {
    expect(screen.getByText("Switch to member")).toBeInTheDocument();
  });
  await user.click(screen.getByText("Switch to member"));
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Switch to member?" }),
    ).toBeInTheDocument();
  });
});

// ORG-I-035
test("shows revoke invitation confirmation dialog when revoke is clicked", async () => {
  const user = userEvent.setup();
  mockMembersAPI({ pendingInvitations: [pendingInvitation] });
  await renderMembersTab();
  await waitFor(() => {
    expect(screen.getByText("invited@example.com")).toBeInTheDocument();
  });
  const invitationRow = screen
    .getByText("invited@example.com")
    .closest("[class*=grid]")!;
  const menuButton = invitationRow.querySelector("button")!;
  await user.click(menuButton);
  await waitFor(() => {
    expect(screen.getByText("Revoke invitation")).toBeInTheDocument();
  });
  await user.click(screen.getByText("Revoke invitation"));
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Revoke invitation?" }),
    ).toBeInTheDocument();
  });
});

// ORG-I-036
test("sends accept request when Accept button is clicked", async () => {
  const user = userEvent.setup();
  let capturedRequestId: string | null = null;
  mockMembersAPI({ membershipRequests: [membershipRequest] });
  server.use(
    http.post("*/api/zero/org/membership-requests", async ({ request }) => {
      const body = (await request.json()) as { requestId: string };
      capturedRequestId = body.requestId;
      return HttpResponse.json({ message: "ok" });
    }),
  );
  await renderMembersTab();
  await waitFor(() => {
    expect(
      screen.getByRole("button", { name: "Accept request" }),
    ).toBeInTheDocument();
  });
  await user.click(screen.getByRole("button", { name: "Accept request" }));
  await waitFor(() => {
    expect(capturedRequestId).toBe("req-001");
  });
});

// ORG-I-037
test("sends reject request when Reject button is clicked", async () => {
  const user = userEvent.setup();
  let capturedRequestId: string | null = null;
  mockMembersAPI({ membershipRequests: [membershipRequest] });
  server.use(
    http.delete("*/api/zero/org/membership-requests", async ({ request }) => {
      const body = (await request.json()) as { requestId: string };
      capturedRequestId = body.requestId;
      return HttpResponse.json({ message: "ok" });
    }),
  );
  await renderMembersTab();
  await waitFor(() => {
    expect(
      screen.getByRole("button", { name: "Reject request" }),
    ).toBeInTheDocument();
  });
  await user.click(screen.getByRole("button", { name: "Reject request" }));
  await waitFor(() => {
    expect(capturedRequestId).toBe("req-001");
  });
});
