/**
 * Display and conditional tests for firewall-allow-page.tsx.
 *
 * Covers agent ID resolution, firewall reference types, HTTP method/path display,
 * loading/error states, PolicyPill states, and admin/member view branching.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { detach, Reason } from "../../../signals/utils.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";

interface AgentResponse {
  agentId: string;
  ownerId: string;
  description: string | null;
  displayName: string | null;
  sound: string | null;
  avatarUrl: string | null;
  firewallPolicies: Record<string, Record<string, string>> | null;
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
    firewallPolicies: null,
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

function mockFirewallRequests(requests: unknown[] = []) {
  server.use(
    http.get("*/api/zero/firewall-access-requests", () => {
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

describe("fw-d-001: agent ID renders from signal", () => {
  it("uses agentId from the URL path to load the correct agent", async () => {
    mockAgent(defaultAgent({ displayName: "Special Agent Smith" }));
    mockFirewallRequests();
    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=github&permission=issues:read`,
    });
    await waitFor(() => {
      expect(screen.getByText(/Special Agent Smith/)).toBeInTheDocument();
    });
  });
});

describe("fw-d-002: firewall reference type displays", () => {
  it("shows the firewall reference type in the page header", async () => {
    mockFirewallRequests();
    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=github&permission=issues:read`,
    });
    await waitFor(() => {
      expect(screen.getByText(/GitHub Firewall/)).toBeInTheDocument();
    });
  });
});

describe("fw-d-003: HTTP method displays", () => {
  it("shows the HTTP method in the blocked request context box", async () => {
    mockFirewallRequests();
    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=github&permission=issues:read&method=POST&path=/repos/owner/repo/issues`,
    });
    await waitFor(() => {
      expect(screen.getByText(/POST/)).toBeInTheDocument();
    });
  });
});

describe("fw-d-004: request path displays", () => {
  it("shows the request path in the blocked request context box", async () => {
    mockFirewallRequests();
    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=github&permission=issues:read&method=GET&path=/repos/owner/repo/issues`,
    });
    await waitFor(() => {
      expect(
        screen.getByText(/\/repos\/owner\/repo\/issues/),
      ).toBeInTheDocument();
    });
  });
});

describe("fw-d-005: agent display name renders", () => {
  it("shows the agent displayName when set", async () => {
    mockAgent(defaultAgent({ displayName: "My Smart Bot" }));
    mockFirewallRequests();
    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=github&permission=issues:read`,
    });
    await waitFor(() => {
      expect(screen.getByText(/My Smart Bot/)).toBeInTheDocument();
    });
  });

  it("falls back to agentId when displayName is null", async () => {
    mockAgent(defaultAgent({ displayName: null }));
    mockFirewallRequests();
    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=github&permission=issues:read`,
    });
    await waitFor(() => {
      expect(screen.getByText(new RegExp(AGENT_ID))).toBeInTheDocument();
    });
  });
});

describe("fw-d-006: connector label from CONNECTOR_TYPES renders", () => {
  it("resolves and displays the connector label for gmail", async () => {
    mockFirewallRequests();
    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=gmail`,
    });
    await waitFor(() => {
      expect(screen.getByText(/Gmail Firewall/)).toBeInTheDocument();
    });
  });
});

describe("fw-d-007: loading state shows while agent loads", () => {
  it("shows a loading state while the agent is being fetched", async () => {
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
    mockFirewallRequests();

    // Fire setupPage without awaiting — it blocks at get(firewallAllowAgent$) while
    // the network response is delayed. The component renders and shows "Loading...".
    const pagePromise = setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=github`,
    });

    await waitFor(() => {
      expect(screen.getByText("Loading...")).toBeInTheDocument();
    });

    // Release the blocked agent fetch and let the page setup complete.
    unblock();
    await pagePromise;
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
    mockFirewallRequests();

    // The page setup awaits get(firewallAllowAgent$) which rejects on 500.
    // Use detach to silence the expected rejection; the component renders "Failed to load agent".
    detach(
      setupPage({
        context,
        path: `/agents/${AGENT_ID}/permissions?ref=github`,
      }),
      Reason.DomCallback,
    );

    await waitFor(() => {
      expect(screen.getByText("Failed to load agent")).toBeInTheDocument();
    });
  });
});

describe("fw-d-009: AdminFocusedView renders for admins with focused permission", () => {
  it("renders AdminFocusedView with Save button for admin with a permission in URL", async () => {
    mockFirewallRequests();
    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=github&permission=issues:read`,
    });
    await waitFor(() => {
      expect(screen.getByText("issues:read")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });
});

describe("fw-d-010: MemberFocusedView renders for non-admins with focused permission", () => {
  it("renders MemberFocusedView without Save button for non-admin with a permission in URL", async () => {
    setupMemberContext({
      firewallPolicies: { github: { "issues:read": "deny" } },
    });
    mockFirewallRequests();
    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=github&permission=issues:read`,
    });
    await waitFor(() => {
      expect(screen.getByText("issues:read")).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Request Access" }),
    ).toBeInTheDocument();
  });
});

describe("fw-d-011: AdminListView renders for admins without focused permission", () => {
  it("renders AdminListView with Permissions heading and Save button for admin without permission param", async () => {
    mockFirewallRequests();
    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=github`,
    });
    await waitFor(() => {
      expect(screen.getByText("Permissions")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });
});

describe("fw-d-012: MemberListView renders for non-admins without focused permission", () => {
  it("renders MemberListView with Permissions heading and no Save button for non-admin without permission param", async () => {
    setupMemberContext();
    mockFirewallRequests();
    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=github`,
    });
    await waitFor(() => {
      expect(screen.getByText("Permissions")).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();
  });
});

describe("fw-d-013: PolicyPill shows allow state with check icon", () => {
  it("renders the Allow button as active when the policy is allow", async () => {
    mockFirewallRequests();
    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=github&permission=issues:read`,
    });
    await waitFor(() => {
      expect(screen.getByText("issues:read")).toBeInTheDocument();
    });
    const allowButtons = screen.getAllByRole("button", { name: /Allow/ });
    const policyAllowBtn = allowButtons.find((btn) => {
      return btn.className.includes("bg-muted");
    });
    expect(policyAllowBtn).toBeDefined();
  });
});

describe("fw-d-014: PolicyPill shows deny state with ban icon", () => {
  it("renders the Deny button as active when the policy is deny", async () => {
    mockAgent(
      defaultAgent({
        firewallPolicies: { github: { "issues:read": "deny" } },
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
    const denyButtons = screen.getAllByRole("button", { name: /Deny/ });
    const policyDenyBtn = denyButtons.find((btn) => {
      return btn.className.includes("bg-muted");
    });
    expect(policyDenyBtn).toBeDefined();
  });
});

describe("fw-d-023: MemberFocusedView PolicyPill is read-only", () => {
  it("renders PolicyPill buttons as disabled in MemberFocusedView", async () => {
    setupMemberContext({
      firewallPolicies: { github: { "issues:read": "deny" } },
    });
    mockFirewallRequests();
    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?ref=github&permission=issues:read`,
    });
    await waitFor(() => {
      expect(screen.getByText("issues:read")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /Allow/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Deny/ })).toBeDisabled();
  });
});
