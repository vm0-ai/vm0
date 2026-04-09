import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, fill } from "../../../__tests__/page-helper.ts";
import type { OrgMember } from "../../../signals/external/org-members.ts";

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

function mockMembersAPI(members: OrgMember[] = [adminMember, regularMember]) {
  server.use(
    http.get("*/api/zero/org/members", () => {
      return HttpResponse.json({
        slug: "user-12345678",
        role: "admin",
        members,
        pendingInvitations: [],
        createdAt: "2026-01-01T00:00:00Z",
      });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

function renderMembersTab() {
  detachedSetupPage({ context, path: "/?settings=members" });
}

describe("org members - invite dialog loading state", () => {
  it("should show loading state and close after invite completes", async () => {
    const user = userEvent.setup();
    let resolveInvite: (() => void) | null = null;

    mockMembersAPI();
    server.use(
      http.post("*/api/zero/org/invite", () => {
        return new Promise<Response>((resolve) => {
          resolveInvite = () => {
            return resolve(
              HttpResponse.json({ message: "ok" }, { status: 200 }),
            );
          };
        });
      }),
    );

    await renderMembersTab();

    await waitFor(() => {
      expect(screen.getByText("admin@example.com")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Add member"));
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Invite member" }),
      ).toBeInTheDocument();
    });

    const emailInput = screen.getByPlaceholderText("email@example.com");
    await fill(emailInput, "new@example.com");
    await user.click(screen.getByText("Send invitation"));

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
    const user = userEvent.setup();
    let resolveInvite: (() => void) | null = null;

    mockMembersAPI();
    server.use(
      http.post("*/api/zero/org/invite", () => {
        return new Promise<Response>((resolve) => {
          resolveInvite = () => {
            return resolve(
              HttpResponse.json({ message: "ok" }, { status: 200 }),
            );
          };
        });
      }),
    );

    await renderMembersTab();

    await waitFor(() => {
      expect(screen.getByText("admin@example.com")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Add member"));
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Invite member" }),
      ).toBeInTheDocument();
    });

    const emailInput = screen.getByPlaceholderText("email@example.com");
    await fill(emailInput, "new@example.com");
    await user.click(screen.getByText("Send invitation"));

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
    const user = userEvent.setup();
    mockMembersAPI();
    server.use(
      http.post("*/api/zero/org/invite", () => {
        return HttpResponse.json({ message: "ok" }, { status: 200 });
      }),
    );

    await renderMembersTab();

    await waitFor(() => {
      expect(screen.getByText("admin@example.com")).toBeInTheDocument();
    });

    // Open invite dialog
    await user.click(screen.getByText("Add member"));
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
    const user = userEvent.setup();
    let capturedBody: Record<string, unknown> | null = null;

    mockMembersAPI();
    server.use(
      http.post("*/api/zero/org/invite", async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ message: "ok" }, { status: 200 });
      }),
    );

    await renderMembersTab();

    await waitFor(() => {
      expect(screen.getByText("admin@example.com")).toBeInTheDocument();
    });

    // Open invite dialog
    await user.click(screen.getByText("Add member"));
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Invite member" }),
      ).toBeInTheDocument();
    });

    // Fill email
    const emailInput = screen.getByPlaceholderText("email@example.com");
    await fill(emailInput, "new-admin@example.com");

    // Change role to Admin
    await user.click(screen.getByRole("combobox"));
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Admin" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("option", { name: "Admin" }));

    // Submit
    await user.click(screen.getByText("Send invitation"));

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
    const user = userEvent.setup();
    let resolveRoleChange: (() => void) | null = null;

    mockMembersAPI([adminMember, regularMember]);
    server.use(
      http.patch("*/api/zero/org/members", () => {
        return new Promise<Response>((resolve) => {
          resolveRoleChange = () => {
            return resolve(
              HttpResponse.json({ message: "Role updated" }, { status: 200 }),
            );
          };
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
    await user.click(actionButton);

    await waitFor(() => {
      expect(screen.getByText("Make admin")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Make admin"));

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
    mockMembersAPI([adminMember, regularMember]);

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
    mockMembersAPI([adminMember, secondAdmin, regularMember]);

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
