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
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  fill,
  click,
} from "../../../__tests__/page-helper.ts";
import {
  type PermissionAccessRequestResponse,
  zeroAgentsByIdContract,
  zeroAgentPermissionPoliciesContract,
  permissionAccessRequestsListContract,
  permissionAccessRequestsResolveContract,
  permissionAccessRequestsCreateContract,
} from "@vm0/core/contracts/zero-agents";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { setMockPermissionRequests } from "../../../mocks/handlers/api-permission-access-requests.ts";
import { setMockOrg } from "../../../mocks/handlers/api-org.ts";

const context = testContext();
const mockApi = createMockApi(context);

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
    mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
      return respond(200, defaultAgentResponse(overrides));
    }),
  );
}

function mockPermissionRequests(
  requests: PermissionAccessRequestResponse[] = [],
) {
  setMockPermissionRequests(requests);
}

function setupMemberContext(agentOverrides?: Record<string, unknown>) {
  setMockOrg({ role: "member" });
  server.use(
    mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
      return respond(
        200,
        defaultAgentResponse({
          ownerId: "other-owner-id",
          ...agentOverrides,
        }),
      );
    }),
  );
}

function pendingRequest(
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
      mockApi(
        zeroAgentPermissionPoliciesContract.update,
        ({ body, respond }) => {
          savedBody = body;
          return respond(200, defaultAgentResponse());
        },
      ),
    );
    mockAgent();
    mockPermissionRequests();

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=slack&permission=channels:read&action=deny`,
    });

    await waitFor(() => {
      expect(screen.getByText("Confirm")).toBeInTheDocument();
    });

    click(screen.getByText("Confirm"));

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
      mockApi(zeroAgentPermissionPoliciesContract.update, ({ respond }) => {
        return respond(
          200,
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

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=slack&permission=channels:read&action=deny`,
    });

    await waitFor(() => {
      expect(screen.getByText("Confirm")).toBeInTheDocument();
    });

    click(screen.getByText("Confirm"));

    // action=deny → after save the "Permissions denied" confirmation card appears
    await waitFor(() => {
      expect(screen.getByText("Permissions denied")).toBeInTheDocument();
    });
  });

  it("fw-d-020: shows Permissions denied card for deny action", async () => {
    server.use(
      mockApi(zeroAgentPermissionPoliciesContract.update, ({ respond }) => {
        return respond(
          200,
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

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=slack&permission=channels:read&action=deny`,
    });

    await waitFor(() => {
      expect(screen.getByText("Confirm")).toBeInTheDocument();
    });

    click(screen.getByText("Confirm"));

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
    let requestStatus: PermissionAccessRequestResponse["status"] = "pending";
    server.use(
      mockApi(
        permissionAccessRequestsResolveContract.resolve,
        ({ respond }) => {
          requestStatus = "approved";
          return respond(200, {
            ...pendingRequest(),
            status: "approved",
            resolvedBy: "test-user-123",
            resolvedAt: "2026-04-03T00:00:00Z",
          });
        },
      ),
      mockApi(permissionAccessRequestsListContract.list, ({ respond }) => {
        return respond(200, [{ ...pendingRequest(), status: requestStatus }]);
      }),
    );
    mockAgent();

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?request=${REQUEST_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByText("Approve change")).toBeInTheDocument();
    });

    click(screen.getByText("Approve change"));

    await waitFor(() => {
      expect(screen.getByText("Permissions updated")).toBeInTheDocument();
    });
  });

  it("fw-d-022: Deny change button rejects pending request", async () => {
    let requestStatus: PermissionAccessRequestResponse["status"] = "pending";
    server.use(
      mockApi(
        permissionAccessRequestsResolveContract.resolve,
        ({ respond }) => {
          requestStatus = "rejected";
          return respond(200, {
            ...pendingRequest(),
            status: "rejected",
            resolvedBy: "test-user-123",
            resolvedAt: "2026-04-03T00:00:00Z",
          });
        },
      ),
      mockApi(permissionAccessRequestsListContract.list, ({ respond }) => {
        return respond(200, [{ ...pendingRequest(), status: requestStatus }]);
      }),
    );
    mockAgent();

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?request=${REQUEST_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByText("Deny change")).toBeInTheDocument();
    });

    click(screen.getByText("Deny change"));

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

    detachedSetupPage({
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
      mockApi(
        permissionAccessRequestsCreateContract.create,
        ({ body, respond }) => {
          requestBody = body;
          return respond(201, {
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
          });
        },
      ),
    );
    setupMemberContext();
    mockPermissionRequests();

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=slack&permission=channels:read&action=deny`,
    });

    await waitFor(() => {
      expect(screen.getByText("Request approval")).toBeInTheDocument();
    });

    click(screen.getByText("Request approval"));

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

    detachedSetupPage({
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

    detachedSetupPage({
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

    detachedSetupPage({
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
    let requestBody: unknown;
    server.use(
      mockApi(
        permissionAccessRequestsCreateContract.create,
        ({ body, respond }) => {
          requestBody = body;
          return respond(201, {
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
          });
        },
      ),
    );
    setupMemberContext();
    mockPermissionRequests();

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=slack&permission=channels:read&action=deny&reason=Original+reason`,
    });

    await waitFor(() => {
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });

    const textarea = screen.getByRole("textbox");
    await fill(textarea, "Edited reason");

    click(screen.getByText("Request approval"));

    await waitFor(() => {
      expect(requestBody).toBeDefined();
    });

    expect(requestBody).toMatchObject({
      reason: "Edited reason",
    });
  });
});
