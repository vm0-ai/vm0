import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";

function defaultAgentResponse() {
  return {
    agentId: AGENT_ID,
    ownerId: "test-user-123",
    description: null,
    displayName: null,
    sound: null,
    avatarUrl: null,
    firewallPolicies: null,
    customSkills: [],
  };
}

function mockFirewallRequests(requests: unknown[] = []) {
  server.use(
    http.get("*/api/zero/firewall-access-requests", () => {
      return HttpResponse.json(requests);
    }),
  );
}

function setupMemberContext() {
  server.use(
    http.get("*/api/zero/org", () => {
      return HttpResponse.json({
        id: "org_1",
        slug: "user-12345678",
        name: "User 12345678",
        role: "member",
      });
    }),
    http.get("*/api/zero/agents/:name", ({ params }) => {
      if (
        params.name === "instructions" ||
        (typeof params.name === "string" && params.name.includes("/"))
      ) {
        return;
      }
      return HttpResponse.json({
        agentId: AGENT_ID,
        ownerId: "other-owner-id",
        description: null,
        displayName: null,
        sound: null,
        avatarUrl: null,
        firewallPolicies: { github: { "issues:read": "deny" } },
        customSkills: [],
      });
    }),
  );
}

function pendingRequest() {
  return {
    id: "d0000000-0000-4000-a000-000000000001",
    agentId: AGENT_ID,
    firewallRef: "github",
    permission: "issues:read",
    method: null,
    path: null,
    reason: "Need access",
    status: "pending",
    requesterUserId: "user_abc",
    requesterName: "Alice Smith",
    resolvedBy: null,
    resolvedAt: null,
    createdAt: "2026-03-10T00:00:00Z",
  };
}

describe("firewall allow page - PolicyPill interactions", () => {
  it("fw-d-015: Allow button toggles policy to allow", async () => {
    // Start with deny policy so clicking Allow makes it dirty
    server.use(
      http.get("*/api/zero/agents/:name", ({ params }) => {
        if (
          params.name === "instructions" ||
          (typeof params.name === "string" && params.name.includes("/"))
        ) {
          return;
        }
        return HttpResponse.json({
          ...defaultAgentResponse(),
          firewallPolicies: { github: { "issues:read": "deny" } },
        });
      }),
    );
    mockFirewallRequests();

    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=github&permission=issues:read`,
    });

    await waitFor(() => {
      expect(screen.getByText("issues:read")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText(/Allow/));

    // After clicking Allow, policy override is "allow" but current policy from server is "deny"
    // so isDirty = true → Save becomes enabled
    await waitFor(() => {
      expect(screen.getByText("Save")).not.toBeDisabled();
    });
  });

  it("fw-d-016: Deny button toggles policy to deny", async () => {
    // Default agent has no firewall policies (defaults to allow), so clicking Deny makes it dirty
    mockFirewallRequests();

    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=github&permission=issues:read`,
    });

    await waitFor(() => {
      expect(screen.getByText("issues:read")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText(/Deny/));

    // After clicking Deny, policy is dirty (override deny, current allow), Save becomes enabled
    await waitFor(() => {
      expect(screen.getByText("Save")).not.toBeDisabled();
    });
  });

  it("fw-d-017: PolicyPill disabled state prevents interaction", async () => {
    // Member view renders PolicyPill with disabled prop
    setupMemberContext();
    mockFirewallRequests();

    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=github&permission=issues:read`,
    });

    await waitFor(() => {
      expect(screen.getByText("issues:read")).toBeInTheDocument();
    });

    const allowButton = screen.getByText(/Allow/);
    const denyButton = screen.getByText(/Deny/);

    expect(allowButton).toBeDisabled();
    expect(denyButton).toBeDisabled();
  });
});

describe("firewall allow page - AdminFocusedView", () => {
  it("fw-d-018: Save button saves the policy", async () => {
    let savedBody: unknown;
    // Stateful agent mock: starts with deny, after save returns allow
    let savedPolicies: Record<string, string> = { "issues:read": "deny" };
    server.use(
      http.put("*/api/zero/firewall-policies", async ({ request }) => {
        savedBody = await request.json();
        savedPolicies = { "issues:read": "allow" };
        return HttpResponse.json({
          ...defaultAgentResponse(),
          firewallPolicies: { github: savedPolicies },
        });
      }),
      http.get("*/api/zero/agents/:name", ({ params }) => {
        if (
          params.name === "instructions" ||
          (typeof params.name === "string" && params.name.includes("/"))
        ) {
          return;
        }
        return HttpResponse.json({
          ...defaultAgentResponse(),
          firewallPolicies: { github: savedPolicies },
        });
      }),
    );
    mockFirewallRequests();

    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=github&permission=issues:read`,
    });

    await waitFor(() => {
      expect(screen.getByText("issues:read")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    // Current policy from agent mock starts as "deny", so clicking Allow makes it dirty
    await user.click(screen.getByText(/Allow/));
    await waitFor(() => {
      expect(screen.getByText("Save")).not.toBeDisabled();
    });

    await user.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(screen.getByText("Saved")).toBeInTheDocument();
    });

    expect(savedBody).toMatchObject({
      policies: { github: { "issues:read": "allow" } },
    });
  });

  it("fw-d-019: Save button is disabled when not dirty", async () => {
    mockFirewallRequests();

    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=github&permission=issues:read`,
    });

    await waitFor(() => {
      expect(screen.getByText("issues:read")).toBeInTheDocument();
    });

    expect(screen.getByText("Save")).toBeDisabled();
  });

  it("fw-d-020: Save button is disabled while saving", async () => {
    let unblock!: () => void;
    // Stateful agent mock: starts with deny, after save returns allow
    let savedPolicies: Record<string, string> = { "issues:read": "deny" };
    server.use(
      http.put("*/api/zero/firewall-policies", async () => {
        savedPolicies = { "issues:read": "allow" };
        await new Promise<void>((resolve) => {
          unblock = resolve;
        });
        return HttpResponse.json({
          ...defaultAgentResponse(),
          firewallPolicies: { github: savedPolicies },
        });
      }),
      http.get("*/api/zero/agents/:name", ({ params }) => {
        if (
          params.name === "instructions" ||
          (typeof params.name === "string" && params.name.includes("/"))
        ) {
          return;
        }
        return HttpResponse.json({
          ...defaultAgentResponse(),
          firewallPolicies: { github: savedPolicies },
        });
      }),
    );
    mockFirewallRequests();

    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=github&permission=issues:read`,
    });

    await waitFor(() => {
      expect(screen.getByText("issues:read")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    // Current policy from agent mock starts as "deny", so clicking Allow makes it dirty
    await user.click(screen.getByText(/Allow/));
    await waitFor(() => {
      expect(screen.getByText("Save")).not.toBeDisabled();
    });

    await user.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(screen.getByText("Saving...")).toBeInTheDocument();
    });
    expect(screen.getByText("Saving...")).toBeDisabled();

    unblock();

    await waitFor(() => {
      expect(screen.getByText("Saved")).toBeInTheDocument();
    });
  });

  it("fw-d-021: Approve button approves pending request", async () => {
    let unblock!: () => void;
    server.use(
      http.put("*/api/zero/firewall-access-requests", async () => {
        await new Promise<void>((resolve) => {
          unblock = resolve;
        });
        return HttpResponse.json({
          ...pendingRequest(),
          status: "approved",
          resolvedBy: "test-user-123",
          resolvedAt: "2026-04-03T00:00:00Z",
        });
      }),
    );
    mockFirewallRequests([pendingRequest()]);

    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=github&permission=issues:read`,
    });

    await waitFor(() => {
      expect(screen.getByText("Alice Smith")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText(/Approve/));

    await waitFor(() => {
      expect(screen.getByText(/Approve/)).toBeDisabled();
    });

    // Unblock the resolve handler; reload will return empty requests
    mockFirewallRequests([]);
    unblock();

    await waitFor(() => {
      expect(screen.queryByText("Alice Smith")).not.toBeInTheDocument();
    });
  });

  it("fw-d-022: Reject button rejects pending request", async () => {
    let unblock!: () => void;
    server.use(
      http.put("*/api/zero/firewall-access-requests", async () => {
        await new Promise<void>((resolve) => {
          unblock = resolve;
        });
        return HttpResponse.json({
          ...pendingRequest(),
          status: "rejected",
          resolvedBy: "test-user-123",
          resolvedAt: "2026-04-03T00:00:00Z",
        });
      }),
    );
    mockFirewallRequests([pendingRequest()]);

    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=github&permission=issues:read`,
    });

    await waitFor(() => {
      expect(screen.getByText("Alice Smith")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText(/Reject/));

    await waitFor(() => {
      expect(screen.getByText(/Reject/)).toBeDisabled();
    });

    // Unblock the resolve handler; reload will return empty requests
    mockFirewallRequests([]);
    unblock();

    await waitFor(() => {
      expect(screen.queryByText("Alice Smith")).not.toBeInTheDocument();
    });
  });
});

describe("firewall allow page - MemberFocusedView request form", () => {
  it("fw-d-024: Request Access button shows form", async () => {
    setupMemberContext();
    mockFirewallRequests();

    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=github&permission=issues:read`,
    });

    await waitFor(() => {
      expect(screen.getByText("Request Access")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("Request Access"));

    await waitFor(() => {
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });
    expect(screen.getByText("Cancel")).toBeInTheDocument();
    expect(screen.getByText("Submit Request")).toBeInTheDocument();
  });

  it("fw-d-025: Reason textarea accepts input", async () => {
    setupMemberContext();
    mockFirewallRequests();

    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=github&permission=issues:read`,
    });

    await waitFor(() => {
      expect(screen.getByText("Request Access")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("Request Access"));

    await waitFor(() => {
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });

    const textarea = screen.getByRole("textbox");
    await user.type(textarea, "I need to read issues");

    expect(textarea).toHaveValue("I need to read issues");
  });

  it("fw-d-026: Cancel button hides request form", async () => {
    setupMemberContext();
    mockFirewallRequests();

    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=github&permission=issues:read`,
    });

    await waitFor(() => {
      expect(screen.getByText("Request Access")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("Request Access"));

    await waitFor(() => {
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Cancel"));

    await waitFor(() => {
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Request Access")).toBeInTheDocument();
  });

  it("fw-d-027: Submit Request button sends the request", async () => {
    let unblock!: () => void;
    server.use(
      http.post("*/api/zero/firewall-access-requests", async () => {
        await new Promise<void>((resolve) => {
          unblock = resolve;
        });
        return HttpResponse.json(
          {
            id: "d1111111-0000-4000-a000-000000000002",
            agentId: AGENT_ID,
            firewallRef: "github",
            permission: "issues:read",
            method: null,
            path: null,
            reason: null,
            status: "pending",
            requesterUserId: "test-user-123",
            requesterName: "Test User",
            resolvedBy: null,
            resolvedAt: null,
            createdAt: "2026-04-03T00:00:00Z",
          },
          { status: 201 },
        );
      }),
    );
    setupMemberContext();
    mockFirewallRequests();

    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=github&permission=issues:read`,
    });

    await waitFor(() => {
      expect(screen.getByText("Request Access")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("Request Access"));

    await waitFor(() => {
      expect(screen.getByText("Submit Request")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Submit Request"));

    await waitFor(() => {
      expect(screen.getByText("Submitting...")).toBeInTheDocument();
    });
    expect(screen.getByText("Submitting...")).toBeDisabled();

    unblock();

    await waitFor(() => {
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    });
  });
});

interface SaveFirewallPoliciesRequest {
  agentId: string;
  policies: { gmail: Record<string, string> };
}

describe("firewall allow page - AdminListView", () => {
  // Use gmail (26 permissions) instead of github (129 permissions) to keep tests fast
  it("fw-d-028: Category header sets all permissions in that category", async () => {
    let savedBody: unknown;
    server.use(
      http.put("*/api/zero/firewall-policies", async ({ request }) => {
        savedBody = await request.json();
        return HttpResponse.json(defaultAgentResponse());
      }),
    );
    mockFirewallRequests();

    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=gmail`,
    });

    await waitFor(() => {
      expect(screen.getByText("Permissions")).toBeInTheDocument();
    });

    const user = userEvent.setup();

    // Scope to the "Read" category header to click its Deny button without relying on DOM order
    const categoryLabel = screen.getByText(/^Read \(\d+\)$/);
    // The category header is the parent element that contains both the label and the policy buttons
    const categoryHeader = categoryLabel.parentElement;
    if (!categoryHeader) {
      throw new Error("Category header not found");
    }
    await user.click(within(categoryHeader).getByText(/Deny/));

    // Click Save to persist all policies
    await user.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(savedBody).toBeDefined();
    });

    // At least one permission in the category should now be "deny"
    const policies = (savedBody as SaveFirewallPoliciesRequest).policies.gmail;
    expect(Object.values(policies)).toContain("deny");
  });

  it("fw-d-029: Individual permission policy change", async () => {
    let savedBody: unknown;
    server.use(
      http.put("*/api/zero/firewall-policies", async ({ request }) => {
        savedBody = await request.json();
        return HttpResponse.json(defaultAgentResponse());
      }),
    );
    mockFirewallRequests();

    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=gmail`,
    });

    await waitFor(() => {
      expect(screen.getByText("Permissions")).toBeInTheDocument();
    });

    const user = userEvent.setup();

    // Scope to a specific permission row by its permission name to click its Deny button
    // gmail.labels is the last permission in the Admin category
    const permLabel = screen.getByText("gmail.labels");
    // <code> → <div class="min-w-0 flex-1"> → <div class="flex items-center ..."> (the row)
    const permRow = permLabel.parentElement?.parentElement;
    if (!permRow) {
      throw new Error("Permission row not found");
    }
    await user.click(within(permRow).getByText(/Deny/));

    await user.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(savedBody).toBeDefined();
    });

    // The saved policies should include at least one "deny" permission
    const policies = (savedBody as SaveFirewallPoliciesRequest).policies.gmail;
    expect(Object.values(policies)).toContain("deny");
  });

  it("fw-d-030: Save button saves all policies", async () => {
    // Note: AdminListView Save is always enabled (not dirty-gated), unlike AdminFocusedView.
    // This allows admins to explicitly re-persist all policies without needing to change them first.
    let unblock!: () => void;
    server.use(
      http.put("*/api/zero/firewall-policies", async () => {
        await new Promise<void>((resolve) => {
          unblock = resolve;
        });
        return HttpResponse.json(defaultAgentResponse());
      }),
    );
    mockFirewallRequests();

    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=gmail`,
    });

    await waitFor(() => {
      expect(screen.getByText("Save")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(screen.getByText("Saving...")).toBeInTheDocument();
    });
    expect(screen.getByText("Saving...")).toBeDisabled();

    unblock();

    await waitFor(() => {
      expect(screen.getByText("Save")).not.toBeDisabled();
    });
  });
});
