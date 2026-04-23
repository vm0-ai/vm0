import { describe, expect, it, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  fill,
  click,
} from "../../../__tests__/page-helper.ts";
import type { OrgMember } from "../../../signals/external/org-members.ts";
import {
  setMockOrgMembers,
  resetMockOrgMembers,
} from "../../../mocks/handlers/api-org-members.ts";
import { zeroOrgMembersContract, zeroOrgInviteContract } from "@vm0/core";
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

beforeEach(() => {
  resetMockOrgMembers();
});

function setupMembersAPI(members: OrgMember[] = [adminMember, regularMember]) {
  setMockOrgMembers({
    slug: "user-12345678",
    role: "admin",
    members,
    pendingInvitations: [],
    createdAt: "2026-01-01T00:00:00Z",
  });
}

function renderMembersTab() {
  detachedSetupPage({ context, path: "/?settings=members" });
}

describe("org members - invite dialog loading state", () => {
  it("should show loading state and close after invite completes", async () => {
    let resolveInvite: (() => void) | null = null;

    setupMembersAPI();
    server.use(
      mockApi(zeroOrgInviteContract.invite, ({ respond, deferred }) => {
        const gate = deferred<void>();
        resolveInvite = () => {
          gate.resolve();
        };
        return gate.promise.then(() => {
          return respond(200, { message: "ok" });
        });
      }),
    );

    await renderMembersTab();

    await waitFor(() => {
      expect(screen.getByText("admin@example.com")).toBeInTheDocument();
    });

    click(screen.getByText("Add member"));
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Invite member" }),
      ).toBeInTheDocument();
    });

    const emailInput = screen.getByPlaceholderText("email@example.com");
    await fill(emailInput, "new@example.com");
    click(screen.getByText("Send invitation"));

    // Should show loading state while dialog stays open
    await waitFor(() => {
      expect(screen.getByText("Sending...")).toBeInTheDocument();
    });
    expect(
      screen.getByRole("heading", { name: "Invite member" }),
    ).toBeInTheDocument();

    // Buttons should be disabled during loading
    expect(screen.getByText("Cancel")).toBeDisabled();
    expect(screen.getByText("Sending...")).toBeDisabled();

    // Resolve the API call
    resolveInvite!();

    // Dialog should close after completion
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Invite member" }),
      ).not.toBeInTheDocument();
    });
  });

  it("should disable input and cancel during invite", async () => {
    let resolveInvite: (() => void) | null = null;

    setupMembersAPI();
    server.use(
      mockApi(zeroOrgInviteContract.invite, ({ respond, deferred }) => {
        const gate = deferred<void>();
        resolveInvite = () => {
          gate.resolve();
        };
        return gate.promise.then(() => {
          return respond(200, { message: "ok" });
        });
      }),
    );

    await renderMembersTab();

    await waitFor(() => {
      expect(screen.getByText("admin@example.com")).toBeInTheDocument();
    });

    click(screen.getByText("Add member"));
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Invite member" }),
      ).toBeInTheDocument();
    });

    const emailInput = screen.getByPlaceholderText("email@example.com");
    await fill(emailInput, "new@example.com");
    click(screen.getByText("Send invitation"));

    await waitFor(() => {
      expect(screen.getByText("Sending...")).toBeInTheDocument();
    });

    // Email input should be disabled during loading
    expect(screen.getByPlaceholderText("email@example.com")).toBeDisabled();

    // Cleanup
    resolveInvite!();
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Invite member" }),
      ).not.toBeInTheDocument();
    });
  });
});

describe("org members - invite dialog role selector", () => {
  it("should show role selector defaulting to Member", async () => {
    setupMembersAPI();

    await renderMembersTab();

    await waitFor(() => {
      expect(screen.getByText("admin@example.com")).toBeInTheDocument();
    });

    // Open invite dialog
    click(screen.getByText("Add member"));
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Invite member" }),
      ).toBeInTheDocument();
    });

    // Role label and selector should be present within the dialog
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Role")).toBeInTheDocument();
    // The select trigger should show the default "Member" value
    expect(within(dialog).getByRole("combobox")).toHaveTextContent("Member");
  });

  it("should send invite with selected admin role", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    setupMembersAPI();
    server.use(
      mockApi(zeroOrgInviteContract.invite, ({ body, respond }) => {
        capturedBody = body as Record<string, unknown>;
        return respond(200, { message: "ok" });
      }),
    );

    await renderMembersTab();

    await waitFor(() => {
      expect(screen.getByText("admin@example.com")).toBeInTheDocument();
    });

    // Open invite dialog
    click(screen.getByText("Add member"));
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Invite member" }),
      ).toBeInTheDocument();
    });

    // Fill email
    const emailInput = screen.getByPlaceholderText("email@example.com");
    await fill(emailInput, "new-admin@example.com");

    // Change role to Admin
    click(screen.getByRole("combobox"));
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Admin" })).toBeInTheDocument();
    });
    click(screen.getByRole("option", { name: "Admin" }));

    // Submit
    click(screen.getByText("Send invitation"));

    // Wait for dialog to close (invite succeeded)
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Invite member" }),
      ).not.toBeInTheDocument();
    });

    // Verify the request body included role: "admin"
    expect(capturedBody).toMatchObject({
      email: "new-admin@example.com",
      role: "admin",
    });
  });
});

describe("org members - role change loading state", () => {
  it("should disable action menu while role change API is pending", async () => {
    let resolveRoleChange: (() => void) | null = null;

    setupMembersAPI([adminMember, regularMember]);
    server.use(
      mockApi(zeroOrgMembersContract.updateRole, ({ respond, deferred }) => {
        const gate = deferred<void>();
        resolveRoleChange = () => {
          gate.resolve();
        };
        return gate.promise.then(() => {
          return respond(200, { message: "Role updated" });
        });
      }),
    );

    await renderMembersTab();

    await waitFor(() => {
      expect(screen.getByText("member@example.com")).toBeInTheDocument();
    });

    // Open the action menu for the regular member
    const actionButton = screen.getByLabelText(
      "Actions for member@example.com",
    );
    click(actionButton);

    await waitFor(() => {
      expect(screen.getByText("Make admin")).toBeInTheDocument();
    });
    click(screen.getByText("Make admin"));

    // The action button should be disabled while the role change is pending
    await waitFor(() => {
      expect(
        screen.getByLabelText("Actions for member@example.com"),
      ).toBeDisabled();
    });

    resolveRoleChange!();

    await waitFor(() => {
      expect(
        screen.getByLabelText("Actions for member@example.com"),
      ).toBeEnabled();
    });
  });
});

describe("org members - sole admin self-demote protection", () => {
  it("should not show self-demote menu when user is the only admin", async () => {
    setupMembersAPI([adminMember, regularMember]);

    await renderMembersTab();

    await waitFor(() => {
      expect(screen.getByText("admin@example.com")).toBeInTheDocument();
    });

    // The admin row for the current user should exist but have no action menu
    const adminRow = screen.getByText("Admin User").closest("[class*=grid]")!;
    const menuButton = adminRow.querySelector("button[class*=rounded-md]");
    expect(menuButton).toBeNull();
  });

  it("should show self-demote menu when multiple admins exist", async () => {
    setupMembersAPI([adminMember, secondAdmin, regularMember]);

    await renderMembersTab();

    await waitFor(() => {
      expect(screen.getByText("admin@example.com")).toBeInTheDocument();
    });

    // The current user's admin row should have an action menu button
    const youBadge = screen.getByText("You");
    const adminRow = youBadge.closest("[class*=grid]")!;
    const menuButton = adminRow.querySelector("button");
    expect(menuButton).not.toBeNull();
  });
});
