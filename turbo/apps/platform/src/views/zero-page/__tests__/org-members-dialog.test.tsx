import { describe, expect, it } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
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
        members,
        pendingInvitations: [],
      });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

async function renderMembersTab() {
  await setupPage({ context, path: "/?settings=members" });
}

describe("org members - invite dialog loading state", () => {
  it("should show loading state and close after invite completes", async () => {
    let resolveInvite: (() => void) | null = null;

    mockMembersAPI();
    server.use(
      http.post("*/api/zero/org/invite", () => {
        return new Promise<Response>((resolve) => {
          resolveInvite = () =>
            resolve(HttpResponse.json({ message: "ok" }, { status: 200 }));
        });
      }),
    );

    await renderMembersTab();

    await waitFor(() => {
      expect(screen.getByText("admin@example.com")).toBeInTheDocument();
    });

    // Open invite dialog
    fireEvent.click(screen.getByRole("button", { name: /Add member/i }));
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Invite member" }),
      ).toBeInTheDocument();
    });

    // Fill email and submit
    const emailInput = screen.getByPlaceholderText("email@example.com");
    fireEvent.change(emailInput, { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Send invitation/i }));

    // Should show loading state while dialog stays open
    await waitFor(() => {
      expect(screen.getByText("Sending...")).toBeInTheDocument();
    });
    expect(
      screen.getByRole("heading", { name: "Invite member" }),
    ).toBeInTheDocument();

    // Buttons should be disabled during loading
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sending..." })).toBeDisabled();

    // Resolve the API call
    resolveInvite!();

    // Dialog should close after completion
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Invite member" }),
      ).not.toBeInTheDocument();
    });
  });

  it("should keep dialog open on invite error", async () => {
    mockMembersAPI();
    server.use(
      http.post("*/api/zero/org/invite", () => {
        return HttpResponse.json(
          { error: { message: "Already a member" } },
          { status: 400 },
        );
      }),
    );

    await renderMembersTab();

    await waitFor(() => {
      expect(screen.getByText("admin@example.com")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Add member/i }));
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Invite member" }),
      ).toBeInTheDocument();
    });

    const emailInput = screen.getByPlaceholderText("email@example.com");
    fireEvent.change(emailInput, { target: { value: "admin@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Send invitation/i }));

    // Loading appears briefly, then clears
    await waitFor(() => {
      expect(screen.getByText("Sending...")).toBeInTheDocument();
    });

    // After error resolves, dialog stays open (loading clears)
    await waitFor(() => {
      expect(screen.getByText("Send invitation")).toBeInTheDocument();
    });
    expect(
      screen.getByRole("heading", { name: "Invite member" }),
    ).toBeInTheDocument();
  });

  it("should disable input and cancel during invite", async () => {
    let resolveInvite: (() => void) | null = null;

    mockMembersAPI();
    server.use(
      http.post("*/api/zero/org/invite", () => {
        return new Promise<Response>((resolve) => {
          resolveInvite = () =>
            resolve(HttpResponse.json({ message: "ok" }, { status: 200 }));
        });
      }),
    );

    await renderMembersTab();

    await waitFor(() => {
      expect(screen.getByText("admin@example.com")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Add member/i }));
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Invite member" }),
      ).toBeInTheDocument();
    });

    const emailInput = screen.getByPlaceholderText("email@example.com");
    fireEvent.change(emailInput, { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Send invitation/i }));

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
