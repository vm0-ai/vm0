import { expect, test, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  fill,
  click,
} from "../../../__tests__/page-helper.ts";
import type {
  OrgMember,
  OrgPendingInvitation,
  OrgMembershipRequest,
} from "../../../signals/external/org-members.ts";
import {
  setMockOrgMembers,
  resetMockOrgMembers,
} from "../../../mocks/handlers/api-org-members.ts";
import {
  zeroOrgMembersContract,
  zeroOrgInviteContract,
  zeroOrgMembershipRequestsContract,
} from "@vm0/core/contracts/zero-org-members";
import { createMockApi } from "../../../mocks/msw-contract.ts";

const context = testContext();
const mockApi = createMockApi(context);

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

beforeEach(() => {
  resetMockOrgMembers();
});

function setupMembersAPI(options?: {
  members?: OrgMember[];
  pendingInvitations?: OrgPendingInvitation[];
  membershipRequests?: OrgMembershipRequest[];
}) {
  setMockOrgMembers({
    slug: "user-12345678",
    role: "admin",
    members: options?.members ?? [adminMember, regularMember],
    pendingInvitations: options?.pendingInvitations ?? [],
    membershipRequests: options?.membershipRequests ?? [],
    createdAt: "2026-01-01T00:00:00Z",
  });
}

function renderMembersTab() {
  detachedSetupPage({ context, path: "/?settings=members" });
}

// ORG-D-022
test("shows member name and email in member row", async () => {
  setupMembersAPI({ members: [regularMember] });
  await renderMembersTab();
  await waitFor(() => {
    expect(screen.getByText("Regular Member")).toBeInTheDocument();
    expect(screen.getByText("member@example.com")).toBeInTheDocument();
  });
});

// ORG-D-023
test("shows profile image when available and initial letter fallback when not", async () => {
  setupMembersAPI({ members: [adminMember, memberWithImage] });
  await renderMembersTab();
  await waitFor(() => {
    expect(screen.getByRole("img", { name: "Image User" })).toBeInTheDocument();
  });
  // adminMember has no imageUrl — should show initial letter "A"
  expect(screen.getByText("A")).toBeInTheDocument();
});

// ORG-D-024
test("shows pending invitations in the member list", async () => {
  setupMembersAPI({ pendingInvitations: [pendingInvitation] });
  await renderMembersTab();
  await waitFor(() => {
    expect(screen.getByText("invited@example.com")).toBeInTheDocument();
  });
});

// ORG-D-025
test("shows membership requests with Accept and Reject buttons", async () => {
  setupMembersAPI({ membershipRequests: [membershipRequest] });
  await renderMembersTab();
  await waitFor(() => {
    expect(screen.getByTitle("Accept request")).toBeInTheDocument();
    expect(screen.getByTitle("Reject request")).toBeInTheDocument();
  });
});

// ORG-D-026
test("shows current user indicator on the current user row", async () => {
  setupMembersAPI({ members: [adminMember] });
  await renderMembersTab();
  await waitFor(() => {
    expect(screen.getByTestId("current-user-indicator")).toBeInTheDocument();
  });
});

// ORG-C-028
test("shows empty state when no members match search", async () => {
  setupMembersAPI({ members: [regularMember] });
  await renderMembersTab();
  await waitFor(() => {
    expect(screen.getByText("Regular Member")).toBeInTheDocument();
  });
  const searchInput = screen.getByPlaceholderText("Search");
  await fill(searchInput, "xyz-no-match");
  await waitFor(() => {
    expect(screen.queryByText("Regular Member")).not.toBeInTheDocument();
    expect(screen.getByText("No members found")).toBeInTheDocument();
  });
});

// ORG-I-029
test("filters member list when search input is used", async () => {
  setupMembersAPI({ members: [adminMember, regularMember] });
  await renderMembersTab();
  await waitFor(() => {
    expect(screen.getByText("admin@example.com")).toBeInTheDocument();
    expect(screen.getByText("member@example.com")).toBeInTheDocument();
  });
  const searchInput = screen.getByPlaceholderText("Search");
  await fill(searchInput, "admin");
  await waitFor(() => {
    expect(screen.getByText("admin@example.com")).toBeInTheDocument();
    expect(screen.queryByText("member@example.com")).not.toBeInTheDocument();
  });
});

// ORG-I-030
test("opens invite dialog when Add member button is clicked", async () => {
  setupMembersAPI();
  await renderMembersTab();
  await waitFor(() => {
    expect(screen.getByText("admin@example.com")).toBeInTheDocument();
  });
  const addMemberButton = screen.getAllByRole("button").find((el) => {
    return /Add member/i.test(el.textContent ?? "");
  });
  expect(addMemberButton).toBeDefined();
  click(addMemberButton!);
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Invite member" }),
    ).toBeInTheDocument();
  });
});

// ORG-I-031
test("sends invite with typed email when Send invitation is clicked", async () => {
  let capturedEmail: string | null = null;
  setupMembersAPI();
  server.use(
    mockApi(zeroOrgInviteContract.invite, ({ body, respond }) => {
      capturedEmail = body.email;
      return respond(200, { message: "ok" });
    }),
  );
  await renderMembersTab();
  await waitFor(() => {
    expect(screen.getByText("admin@example.com")).toBeInTheDocument();
  });
  const addMemberButton031 = screen.getAllByRole("button").find((el) => {
    return /Add member/i.test(el.textContent ?? "");
  });
  expect(addMemberButton031).toBeDefined();
  click(addMemberButton031!);
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Invite member" }),
    ).toBeInTheDocument();
  });
  const emailInput = screen.getByPlaceholderText("email@example.com");
  await fill(emailInput, "test@invite.com");
  const sendButton031 = screen.getAllByRole("button").find((el) => {
    return el.textContent === "Send invitation";
  });
  expect(sendButton031).toBeDefined();
  click(sendButton031!);
  await waitFor(() => {
    expect(capturedEmail).toBe("test@invite.com");
  });
});

// ORG-I-032
test("sends invite with Admin role when Admin is selected in role dropdown", async () => {
  let capturedRole: string | null = null;
  setupMembersAPI();
  server.use(
    mockApi(zeroOrgInviteContract.invite, ({ body, respond }) => {
      capturedRole = body.role ?? "member";
      return respond(200, { message: "ok" });
    }),
  );
  await renderMembersTab();
  await waitFor(() => {
    expect(screen.getByText("admin@example.com")).toBeInTheDocument();
  });
  const addMemberButton032 = screen.getAllByRole("button").find((el) => {
    return /Add member/i.test(el.textContent ?? "");
  });
  expect(addMemberButton032).toBeDefined();
  click(addMemberButton032!);
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Invite member" }),
    ).toBeInTheDocument();
  });
  const emailInput = screen.getByPlaceholderText("email@example.com");
  await fill(emailInput, "newadmin@example.com");
  click(screen.getByRole("combobox"));
  await waitFor(() => {
    expect(screen.getByRole("option", { name: "Admin" })).toBeInTheDocument();
  });
  click(screen.getByRole("option", { name: "Admin" }));
  const sendButton032 = screen.getAllByRole("button").find((el) => {
    return el.textContent === "Send invitation";
  });
  expect(sendButton032).toBeDefined();
  click(sendButton032!);
  await waitFor(() => {
    expect(capturedRole).toBe("admin");
  });
});

// ORG-I-033
test("sends role update when Make admin is clicked in member action menu", async () => {
  let capturedRoleUpdate: { email: string; role: string } | null = null;
  setupMembersAPI({ members: [adminMember, regularMember] });
  server.use(
    mockApi(zeroOrgMembersContract.updateRole, ({ body, respond }) => {
      capturedRoleUpdate = body;
      return respond(200, { message: "ok" });
    }),
  );
  await renderMembersTab();
  await waitFor(() => {
    expect(screen.getByText("member@example.com")).toBeInTheDocument();
  });
  click(screen.getByLabelText("Actions for member@example.com"));
  await waitFor(() => {
    expect(screen.getByText("Make admin")).toBeInTheDocument();
  });
  click(screen.getByText("Make admin"));
  await waitFor(() => {
    expect(capturedRoleUpdate).toStrictEqual({
      email: "member@example.com",
      role: "admin",
    });
  });
});

// ORG-I-034
test("shows self-demote confirmation dialog when admin switches to member", async () => {
  setupMembersAPI({ members: [adminMember, secondAdmin, regularMember] });
  await renderMembersTab();
  await waitFor(() => {
    expect(screen.getByTestId("current-user-indicator")).toBeInTheDocument();
  });
  click(screen.getByLabelText("Actions for admin@example.com"));
  await waitFor(() => {
    expect(screen.getByText("Switch to member")).toBeInTheDocument();
  });
  click(screen.getByText("Switch to member"));
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Switch to member?" }),
    ).toBeInTheDocument();
  });
});

// ORG-I-035
test("shows revoke invitation confirmation dialog when revoke is clicked", async () => {
  setupMembersAPI({ pendingInvitations: [pendingInvitation] });
  await renderMembersTab();
  await waitFor(() => {
    expect(screen.getByText("invited@example.com")).toBeInTheDocument();
  });
  click(screen.getByLabelText("Actions for invited@example.com"));
  await waitFor(() => {
    expect(screen.getByText("Revoke invitation")).toBeInTheDocument();
  });
  click(screen.getByText("Revoke invitation"));
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Revoke invitation?" }),
    ).toBeInTheDocument();
  });
});

// ORG-I-036
test("sends accept request when Accept button is clicked", async () => {
  let capturedRequestId: string | null = null;
  setupMembersAPI({ membershipRequests: [membershipRequest] });
  server.use(
    mockApi(zeroOrgMembershipRequestsContract.accept, ({ body, respond }) => {
      capturedRequestId = body.requestId;
      return respond(200, { message: "ok" });
    }),
  );
  await renderMembersTab();
  await waitFor(() => {
    expect(screen.getByTitle("Accept request")).toBeInTheDocument();
  });
  click(screen.getByTitle("Accept request"));
  await waitFor(() => {
    expect(capturedRequestId).toBe("req-001");
  });
});

// ORG-I-037
test("sends reject request when Reject button is clicked", async () => {
  let capturedRequestId: string | null = null;
  setupMembersAPI({ membershipRequests: [membershipRequest] });
  server.use(
    mockApi(zeroOrgMembershipRequestsContract.reject, ({ body, respond }) => {
      capturedRequestId = body.requestId;
      return respond(200, { message: "ok" });
    }),
  );
  await renderMembersTab();
  await waitFor(() => {
    expect(screen.getByTitle("Reject request")).toBeInTheDocument();
  });
  click(screen.getByTitle("Reject request"));
  await waitFor(() => {
    expect(capturedRequestId).toBe("req-001");
  });
});
