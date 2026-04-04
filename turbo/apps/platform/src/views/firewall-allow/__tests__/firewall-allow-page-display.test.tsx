/**
 * Display and conditional tests for firewall-allow-page.tsx.
 *
 * Covers agent ID resolution, firewall reference types, loading/error states,
 * and PolicyPill active/disabled states. Admin/member view branching and
 * HTTP method/path display are already covered in firewall-allow-page.test.tsx.
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
    expect(
      screen.getByRole("button", { name: /Allow/, pressed: true }),
    ).toBeInTheDocument();
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
    expect(
      screen.getByRole("button", { name: /Deny/, pressed: true }),
    ).toBeInTheDocument();
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
