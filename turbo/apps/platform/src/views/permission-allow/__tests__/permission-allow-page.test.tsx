import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import type { PermissionAccessRequestResponse } from "@vm0/core";
import { setMockPermissionRequests } from "../../../mocks/handlers/api-permission-access-requests.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const REQUEST_ID = "d0000000-0000-4000-a000-000000000001";

function mockPermissionRequests(
  requests: PermissionAccessRequestResponse[] = [],
) {
  setMockPermissionRequests(requests);
}

function mockMemberOrg() {
  server.use(
    http.get("*/api/zero/org", () => {
      return HttpResponse.json({
        id: "org_1",
        slug: "user-12345678",
        name: "User 12345678",
        role: "member",
      });
    }),
  );
}

function mockAgentWithPolicy(
  permissionPolicies: Record<
    string,
    { policies: Record<string, string>; unknownPolicy?: string }
  > | null,
  ownerId = "test-owner-id",
) {
  server.use(
    http.get("*/api/zero/agents/:name", ({ params }) => {
      if (
        params.name === "instructions" ||
        (typeof params.name === "string" && params.name.includes("/"))
      ) {
        return;
      }
      return HttpResponse.json({
        agentId: AGENT_ID,
        ownerId,
        description: null,
        displayName: null,
        sound: null,
        avatarUrl: null,
        permissionPolicies,
        customSkills: [],
      });
    }),
  );
}

function makePendingRequest(
  overrides?: Partial<PermissionAccessRequestResponse>,
): PermissionAccessRequestResponse {
  return {
    id: REQUEST_ID,
    agentId: AGENT_ID,
    connectorRef: "slack",
    permission: "channels:read",
    action: "allow",
    method: null,
    path: null,
    reason: "Need to read issues",
    status: "pending",
    requesterUserId: "user_abc",
    requesterName: "Alice Smith",
    resolvedBy: null,
    resolvedAt: null,
    createdAt: "2026-03-10T00:00:00Z",
    ...overrides,
  };
}

describe("permission allow page", () => {
  it("shows error when ref query param is missing", async () => {
    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions`,
    });

    await waitFor(() => {
      expect(
        screen.getByText("Missing permission in URL parameters"),
      ).toBeInTheDocument();
    });
  });

  it("shows error for unknown permission", async () => {
    mockPermissionRequests();
    mockAgentWithPolicy(null);

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=slack&permission=nonexistent:perm`,
    });

    await waitFor(() => {
      expect(
        screen.getByText(/Unknown permission: nonexistent:perm/),
      ).toBeInTheDocument();
    });
  });

  it("shows error for unknown connector ref", async () => {
    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=unknown-ref&permission=channels:read`,
    });

    await waitFor(() => {
      expect(
        screen.getByText(/Unknown permission: unknown-ref/),
      ).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Doctor mode: policy already matches
  // ---------------------------------------------------------------------------

  it("shows permissions updated when policy already matches allow action", async () => {
    mockPermissionRequests();
    mockAgentWithPolicy({
      slack: { policies: { "channels:read": "allow" } },
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=slack&permission=channels:read&action=allow`,
    });

    await waitFor(() => {
      expect(screen.getByText("Permissions updated")).toBeInTheDocument();
    });
  });

  it("shows permissions denied when policy already matches deny action", async () => {
    mockPermissionRequests();
    mockAgentWithPolicy({
      slack: { policies: { "channels:read": "deny" } },
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=slack&permission=channels:read&action=deny`,
    });

    await waitFor(() => {
      expect(screen.getByText("Permissions denied")).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Doctor mode: admin confirm
  // ---------------------------------------------------------------------------

  it("shows admin confirm card when policy does not match", async () => {
    mockPermissionRequests();
    mockAgentWithPolicy({
      slack: { policies: { "channels:read": "deny" } },
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=slack&permission=channels:read&action=allow`,
    });

    await waitFor(() => {
      expect(screen.getByText("channels:read")).toBeInTheDocument();
    });

    expect(screen.getByText("Confirm")).toBeInTheDocument();
  });

  it("shows connector info in doctor mode confirm card", async () => {
    mockPermissionRequests();
    mockAgentWithPolicy({
      slack: { policies: { "channels:read": "deny" } },
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=slack&permission=channels:read`,
    });

    await waitFor(() => {
      expect(screen.getByText("Slack")).toBeInTheDocument();
    });

    expect(screen.getByText("channels:read")).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Doctor mode: member request form
  // ---------------------------------------------------------------------------

  it("shows member request form when policy does not match", async () => {
    mockMemberOrg();
    mockAgentWithPolicy(
      { slack: { policies: { "channels:read": "deny" } } },
      "other-owner",
    );
    mockPermissionRequests();

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=slack&permission=channels:read&action=allow`,
    });

    await waitFor(() => {
      expect(screen.getByText("Request approval")).toBeInTheDocument();
    });

    expect(screen.queryByText("Save")).not.toBeInTheDocument();
    expect(screen.queryByText("Confirm")).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Request mode: admin approval
  // ---------------------------------------------------------------------------

  it("shows admin approval card for pending request", async () => {
    mockPermissionRequests([makePendingRequest()]);

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?request=${REQUEST_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByText(/Alice Smith/)).toBeInTheDocument();
    });

    expect(screen.getByText(/Need to read issues/)).toBeInTheDocument();
    expect(screen.getByText("Approve change")).toBeInTheDocument();
    expect(screen.getByText("Deny change")).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Request mode: member copy link
  // ---------------------------------------------------------------------------

  it("shows copy link card for member pending request", async () => {
    mockMemberOrg();
    mockAgentWithPolicy(null, "other-owner");
    mockPermissionRequests([makePendingRequest()]);

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?request=${REQUEST_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByText("Permission change requested successfully"),
      ).toBeInTheDocument();
    });

    expect(screen.getByText("Copy link")).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Request mode: approved
  // ---------------------------------------------------------------------------

  it("shows permissions updated for approved request", async () => {
    mockPermissionRequests([makePendingRequest({ status: "approved" })]);

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?request=${REQUEST_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByText("Permissions updated")).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Request mode: rejected
  // ---------------------------------------------------------------------------

  it("shows denied card for admin on rejected request", async () => {
    mockPermissionRequests([makePendingRequest({ status: "rejected" })]);

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?request=${REQUEST_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByText("Permissions denied")).toBeInTheDocument();
    });

    expect(screen.queryByText("Resend request")).not.toBeInTheDocument();
  });

  it("shows denied card with resend for member on rejected request", async () => {
    mockMemberOrg();
    mockAgentWithPolicy(null, "other-owner");
    mockPermissionRequests([makePendingRequest({ status: "rejected" })]);

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?request=${REQUEST_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByText("Permissions denied")).toBeInTheDocument();
    });

    expect(screen.getByText("Resend request")).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Request mode: not found
  // ---------------------------------------------------------------------------

  it("shows error when request is not found", async () => {
    mockPermissionRequests([]);

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?request=${REQUEST_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByText("Access request not found")).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Admin approval card: reason is read-only (not an input)
  // ---------------------------------------------------------------------------

  it("shows reason as read-only text in admin approval card", async () => {
    mockPermissionRequests([makePendingRequest()]);

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?request=${REQUEST_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByText(/Need to read issues/)).toBeInTheDocument();
    });

    // Reason should not be an editable textarea
    const textareas = screen.queryAllByRole("textbox");
    for (const ta of textareas) {
      expect(ta.textContent).not.toBe("Need to read issues");
    }
  });

  // ---------------------------------------------------------------------------
  // Doctor mode: deny action shows deny icon for admin
  // ---------------------------------------------------------------------------

  it("shows deny icon in admin confirm card for deny action", async () => {
    mockPermissionRequests();
    mockAgentWithPolicy({
      slack: { policies: { "channels:read": "allow" } },
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=slack&permission=channels:read&action=deny`,
    });

    await waitFor(() => {
      expect(screen.getByText("Confirm")).toBeInTheDocument();
    });

    const banIcons = document.querySelectorAll(".tabler-icon-ban");
    expect(banIcons.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Doctor mode: deny action shows deny icon for member
  // ---------------------------------------------------------------------------

  it("shows deny icon in member request form for deny action", async () => {
    mockMemberOrg();
    mockAgentWithPolicy(
      { slack: { policies: { "channels:read": "allow" } } },
      "other-owner",
    );
    mockPermissionRequests();

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=slack&permission=channels:read&action=deny`,
    });

    await waitFor(() => {
      expect(screen.getByText("Request approval")).toBeInTheDocument();
    });

    const banIcons = document.querySelectorAll(".tabler-icon-ban");
    expect(banIcons.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Request mode: deny request shows deny icon in admin approval card
  // ---------------------------------------------------------------------------

  it("shows deny icon in admin approval card for deny request", async () => {
    mockPermissionRequests([makePendingRequest({ action: "deny" })]);

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?request=${REQUEST_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByText(/Alice Smith/)).toBeInTheDocument();
    });

    const banIcons = document.querySelectorAll(".tabler-icon-ban");
    expect(banIcons.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Request mode: deny request shows correct text in member copy link
  // ---------------------------------------------------------------------------

  it("shows copy link card for member pending deny request", async () => {
    mockMemberOrg();
    mockAgentWithPolicy(null, "other-owner");
    mockPermissionRequests([makePendingRequest({ action: "deny" })]);

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?request=${REQUEST_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByText("Permission change requested successfully"),
      ).toBeInTheDocument();
    });

    expect(screen.getByText("Copy link")).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Request mode: resend form is shown after clicking resend
  // ---------------------------------------------------------------------------

  it("shows resend form after clicking resend on rejected request", async () => {
    mockMemberOrg();
    mockAgentWithPolicy(null, "other-owner");
    mockPermissionRequests([makePendingRequest({ status: "rejected" })]);

    const user = userEvent.setup();

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?request=${REQUEST_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByText("Resend request")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Resend request"));

    await waitFor(() => {
      expect(screen.getByText("Request approval")).toBeInTheDocument();
    });

    // Should have a reason textarea
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Doctor mode: member request form has editable reason textarea
  // ---------------------------------------------------------------------------

  it("shows editable reason textarea in member request form", async () => {
    mockMemberOrg();
    mockAgentWithPolicy(
      { slack: { policies: { "channels:read": "deny" } } },
      "other-owner",
    );
    mockPermissionRequests();

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=slack&permission=channels:read&action=allow`,
    });

    await waitFor(() => {
      expect(screen.getByText("Request approval")).toBeInTheDocument();
    });

    const textarea = screen.getByRole("textbox");
    expect(textarea).toBeInTheDocument();
    expect(textarea.tagName).toBe("TEXTAREA");
  });
});
