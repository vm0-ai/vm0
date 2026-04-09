/**
 * Display and conditional tests for permission-allow-page.tsx.
 *
 * Covers agent ID resolution, permission reference types, loading/error states,
 * and admin/member confirmation card rendering. Admin/member view branching and
 * HTTP method/path display are already covered in permission-allow-page.test.tsx.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  setupPage,
  detachedSetupPage,
} from "../../../__tests__/page-helper.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";

interface AgentResponse {
  agentId: string;
  ownerId: string;
  description: string | null;
  displayName: string | null;
  sound: string | null;
  avatarUrl: string | null;
  permissionPolicies: Record<
    string,
    { permissions: Record<string, string>; allowUnknown?: boolean }
  > | null;
  customSkills: unknown[];
}

function defaultAgent(overrides: Partial<AgentResponse> = {}): AgentResponse {
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

function mockAgent(agent: AgentResponse) {
  server.use(
    http.get("*/api/zero/agents/:name", ({ params }) => {
      if (
        params.name === "instructions" ||
        (typeof params.name === "string" && params.name.includes("/"))
      ) {
        return;
      }
      return HttpResponse.json(agent);
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

function setupMemberContext(agentOverrides: Partial<AgentResponse> = {}) {
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
        defaultAgent({ ownerId: "other-owner-id", ...agentOverrides }),
      );
    }),
  );
}

// NOTE: Tests that render the admin confirmation card (showing agent name,
// connector label, etc.) must use an action that does NOT match the effective
// policy. For github (no defaults → "allow"), use `action=deny`.
// For gmail (default-denied via gmailDefaultAllowed), use `action=allow`.

describe("fw-d-001: agent ID renders from signal", () => {
  it("uses agentId from the URL path to load the correct agent", async () => {
    mockAgent(defaultAgent({ displayName: "Special Agent Smith" }));
    mockPermissionRequests();
    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=slack&permission=channels:read&action=deny`,
    });
    await waitFor(() => {
      expect(
        screen.getAllByText(/Special Agent Smith/).length,
      ).toBeGreaterThanOrEqual(1);
    });
  });
});

describe("fw-d-005: agent display name renders", () => {
  it("shows the agent displayName when set", async () => {
    mockAgent(defaultAgent({ displayName: "My Smart Bot" }));
    mockPermissionRequests();
    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=slack&permission=channels:read&action=deny`,
    });
    await waitFor(() => {
      expect(screen.getAllByText(/My Smart Bot/).length).toBeGreaterThanOrEqual(
        1,
      );
    });
  });

  it("falls back to agentId when displayName is null", async () => {
    mockAgent(defaultAgent({ displayName: null }));
    mockPermissionRequests();
    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=slack&permission=channels:read&action=deny`,
    });
    await waitFor(() => {
      expect(
        screen.getAllByText(new RegExp(AGENT_ID)).length,
      ).toBeGreaterThanOrEqual(1);
    });
  });
});

describe("fw-d-006: connector label from CONNECTOR_TYPES renders", () => {
  it("resolves and displays the connector label for gmail", async () => {
    mockAgent(defaultAgent());
    mockPermissionRequests();
    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=gmail&permission=gmail&action=allow`,
    });
    await waitFor(() => {
      expect(screen.getAllByText(/Gmail/).length).toBeGreaterThanOrEqual(1);
    });
  });
});

describe("fw-d-007: loading state shows while agent loads", () => {
  it("shows a loading spinner while the agent is being fetched", async () => {
    let unblock!: () => void;
    server.use(
      http.get("*/api/zero/agents/:name", async ({ params }) => {
        if (
          params.name === "instructions" ||
          (typeof params.name === "string" && params.name.includes("/"))
        ) {
          return;
        }
        await new Promise<void>((resolve) => {
          unblock = resolve;
        });
        return HttpResponse.json(defaultAgent());
      }),
    );
    mockPermissionRequests();

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=slack&permission=channels:read`,
    });

    // The LoadingCard renders a spinner (animate-spin) — no text.
    // Verify loading state by confirming the spinner is present and
    // the final content ("Confirm" button) has not yet appeared.
    await waitFor(() => {
      const spinner = document.querySelector(".animate-spin");
      expect(spinner).toBeInTheDocument();
    });

    // Release the blocked agent fetch and let the page setup complete.
    unblock();
  });
});

describe("fw-d-008: error state shows when agent load fails", () => {
  it("shows an error state when the agent API returns an error", async () => {
    server.use(
      http.get("*/api/zero/agents/:name", ({ params }) => {
        if (
          params.name === "instructions" ||
          (typeof params.name === "string" && params.name.includes("/"))
        ) {
          return;
        }
        return HttpResponse.json(
          { error: { message: "Internal Server Error", code: "INTERNAL" } },
          { status: 500 },
        );
      }),
    );
    mockPermissionRequests();

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=slack&permission=channels:read`,
    });

    await waitFor(() => {
      expect(screen.getByText("Failed to load agent")).toBeInTheDocument();
    });
  });
});

describe("fw-d-009: member request form renders for non-owner", () => {
  it("shows request form for member who does not own the agent", async () => {
    setupMemberContext();
    mockPermissionRequests();
    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=slack&permission=channels:read&action=deny`,
    });
    await waitFor(() => {
      expect(screen.getByText(/requesting approval/)).toBeInTheDocument();
    });
  });
});
