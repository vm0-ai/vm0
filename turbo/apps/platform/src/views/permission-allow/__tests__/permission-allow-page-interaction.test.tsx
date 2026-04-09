/**
 * Interaction tests for permission-allow-page.tsx.
 *
 * Covers admin Confirm button, admin request approve/reject,
 * and member request submission. These test the new centered
 * approval card UI.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage, fill } from "../../../__tests__/page-helper.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const REQUEST_ID = "d0000000-0000-4000-a000-000000000001";

function defaultAgentResponse(overrides?: Record<string, unknown>) {
  return {
    agentId: AGENT_ID,
    ownerId: "test-user-123",
    description: null,
    displayName: null,
    sound: null,
    avatarUrl: null,
    permissionPolicies: null,
    customSkills: [],
    ...overrides,
  };
}

function mockAgent(overrides?: Record<string, unknown>) {
  server.use(
    http.get("*/api/zero/agents/:name", ({ params }) => {
      if (
        params.name === "instructions" ||
        (typeof params.name === "string" && params.name.includes("/"))
      ) {
        return;
      }
      return HttpResponse.json(defaultAgentResponse(overrides));
    }),
  );
}

function mockPermissionRequests(requests: unknown[] = []) {
  server.use(
    http.get("*/api/zero/permission-access-requests", () => {
      return HttpResponse.json(requests);
    }),
  );
}

function setupMemberContext(agentOverrides?: Record<string, unknown>) {
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
      return HttpResponse.json(
        defaultAgentResponse({
          ownerId: "other-owner-id",
          ...agentOverrides,
        }),
      );
    }),
  );
}

function pendingRequest(overrides?: Record<string, unknown>) {
  return {
    id: REQUEST_ID,
    agentId: AGENT_ID,
    connectorRef: "slack",
    permission: "channels:read",
    action: "allow",
    method: null,
    path: null,
    reason: "Need access",
    status: "pending",
    requesterUserId: "user_abc",
    requesterName: "Alice Smith",
    resolvedBy: null,
    resolvedAt: null,
    createdAt: "2026-03-10T00:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Admin doctor mode: Confirm button
// ---------------------------------------------------------------------------

describe("permission allow page - admin doctor mode", () => {
  it("fw-d-018: Confirm button saves the policy", async () => {
    let savedBody: unknown;
    server.use(
      http.put("*/api/zero/permission-policies", async ({ request }) => {
        savedBody = await request.json();
        return HttpResponse.json(defaultAgentResponse());
      }),
    );
    mockAgent();
    mockPermissionRequests();

    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=slack&permission=channels:read&action=deny`,
    });

    await waitFor(() => {
      expect(screen.getByText("Confirm")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("Confirm"));

    await waitFor(() => {
      expect(savedBody).toBeDefined();
    });

    expect(savedBody).toMatchObject({
      agentId: AGENT_ID,
      policies: { slack: { policies: { "channels:read": "deny" } } },
    });
  });

  it("fw-d-019: Confirm shows result card after save", async () => {
    server.use(
      http.put("*/api/zero/permission-policies", () => {
        return HttpResponse.json(
          defaultAgentResponse({
            permissionPolicies: {
              slack: { policies: { "channels:read": "deny" } },
            },
          }),
        );
      }),
    );
    mockAgent();
    mockPermissionRequests();

    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=slack&permission=channels:read&action=deny`,
    });

    await waitFor(() => {
      expect(screen.getByText("Confirm")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("Confirm"));

    // action=deny → after save the "Permissions denied" confirmation card appears
    await waitFor(() => {
      expect(screen.getByText("Permissions denied")).toBeInTheDocument();
    });
  });

  it("fw-d-020: shows Permissions denied card for deny action", async () => {
    server.use(
      http.put("*/api/zero/permission-policies", () => {
        return HttpResponse.json(
          defaultAgentResponse({
            permissionPolicies: {
              slack: { policies: { "channels:read": "deny" } },
            },
          }),
        );
      }),
    );
    // Agent starts with allow policy, action=deny → mismatch → confirmation card
    mockAgent({
      permissionPolicies: {
        slack: { policies: { "channels:read": "allow" } },
      },
    });
    mockPermissionRequests();

    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=slack&permission=channels:read&action=deny`,
    });

    await waitFor(() => {
      expect(screen.getByText("Confirm")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("Confirm"));

    await waitFor(() => {
      expect(screen.getByText("Permissions denied")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Admin request mode: Approve / Disapprove
// ---------------------------------------------------------------------------

describe("permission allow page - admin request mode", () => {
  it("fw-d-021: Approve change button approves pending request", async () => {
    let requestStatus = "pending";
    server.use(
      http.put("*/api/zero/permission-access-requests", () => {
        requestStatus = "approved";
        return HttpResponse.json({
          ...pendingRequest(),
          status: "approved",
          resolvedBy: "test-user-123",
          resolvedAt: "2026-04-03T00:00:00Z",
        });
      }),
      http.get("*/api/zero/permission-access-requests", () => {
        return HttpResponse.json([
          { ...pendingRequest(), status: requestStatus },
        ]);
      }),
    );
    mockAgent();

    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?request=${REQUEST_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByText("Approve change")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("Approve change"));

    await waitFor(() => {
      expect(screen.getByText("Permissions updated")).toBeInTheDocument();
    });
  });

  it("fw-d-022: Deny change button rejects pending request", async () => {
    let requestStatus = "pending";
    server.use(
      http.put("*/api/zero/permission-access-requests", () => {
        requestStatus = "rejected";
        return HttpResponse.json({
          ...pendingRequest(),
          status: "rejected",
          resolvedBy: "test-user-123",
          resolvedAt: "2026-04-03T00:00:00Z",
        });
      }),
      http.get("*/api/zero/permission-access-requests", () => {
        return HttpResponse.json([
          { ...pendingRequest(), status: requestStatus },
        ]);
      }),
    );
    mockAgent();

    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?request=${REQUEST_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByText("Deny change")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("Deny change"));

    await waitFor(() => {
      expect(screen.getByText("Permissions denied")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Member doctor mode: request form
// ---------------------------------------------------------------------------

describe("permission allow page - member request form", () => {
  it("fw-d-025: Reason textarea accepts input", async () => {
    setupMemberContext();
    mockPermissionRequests();

    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=slack&permission=channels:read&action=deny`,
    });

    await waitFor(() => {
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    const textarea = screen.getByRole("textbox");
    await user.type(textarea, "I need to read issues");

    expect(textarea).toHaveValue("I need to read issues");
  });

  it("fw-d-027: Request approval button sends the request", async () => {
    let requestBody: unknown;
    server.use(
      http.post(
        "*/api/zero/permission-access-requests",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json(
            {
              id: "d1111111-0000-4000-a000-000000000002",
              agentId: AGENT_ID,
              connectorRef: "slack",
              permission: "channels:read",
              action: "deny",
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
        },
      ),
    );
    setupMemberContext();
    mockPermissionRequests();

    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=slack&permission=channels:read&action=deny`,
    });

    await waitFor(() => {
      expect(screen.getByText("Request approval")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("Request approval"));

    await waitFor(() => {
      expect(requestBody).toBeDefined();
    });

    expect(requestBody).toMatchObject({
      agentId: AGENT_ID,
      connectorRef: "slack",
      permission: "channels:read",
      action: "deny",
    });
  });

  it("fw-d-028: Reason textarea pre-filled from URL param", async () => {
    setupMemberContext();
    mockPermissionRequests();

    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=slack&permission=channels:read&action=deny&reason=Need+channel+access`,
    });

    await waitFor(() => {
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });

    const textarea = screen.getByRole("textbox");
    expect(textarea).toHaveValue("Need channel access");
  });

  it("fw-d-029: Reason textarea empty when URL has no reason param", async () => {
    setupMemberContext();
    mockPermissionRequests();

    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=slack&permission=channels:read&action=deny`,
    });

    await waitFor(() => {
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });

    const textarea = screen.getByRole("textbox");
    expect(textarea).toHaveValue("");
  });

  it("fw-d-030: Reason with special characters decoded from URL", async () => {
    setupMemberContext();
    mockPermissionRequests();

    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=slack&permission=channels:read&action=deny&reason=Need+access+%26+permissions`,
    });

    await waitFor(() => {
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });

    const textarea = screen.getByRole("textbox");
    expect(textarea).toHaveValue("Need access & permissions");
  });

  it("fw-d-031: Pre-filled reason can be edited before submission", async () => {
    let requestBody: Record<string, unknown> | undefined;
    server.use(
      http.post(
        "*/api/zero/permission-access-requests",
        async ({ request }) => {
          requestBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(
            {
              id: "d0000000-0000-4000-a000-000000000099",
              agentId: AGENT_ID,
              connectorRef: "slack",
              permission: "channels:read",
              action: "deny",
              method: null,
              path: null,
              reason: "Edited reason",
              status: "pending",
              requesterUserId: "user_abc",
              requesterName: null,
              resolvedBy: null,
              resolvedAt: null,
              createdAt: "2026-04-03T00:00:00Z",
            },
            { status: 201 },
          );
        },
      ),
    );
    setupMemberContext();
    mockPermissionRequests();

    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=slack&permission=channels:read&action=deny&reason=Original+reason`,
    });

    await waitFor(() => {
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    const textarea = screen.getByRole("textbox");
    await fill(textarea, "Edited reason");

    await user.click(screen.getByText("Request approval"));

    await waitFor(() => {
      expect(requestBody).toBeDefined();
    });

    expect(requestBody).toMatchObject({
      reason: "Edited reason",
    });
  });
});
