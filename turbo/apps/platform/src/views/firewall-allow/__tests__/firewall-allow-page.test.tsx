import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";

function mockFirewallRequests(requests: unknown[] = []) {
  server.use(
    http.get("*/api/zero/firewall-access-requests", () => {
      return HttpResponse.json(requests);
    }),
  );
}

describe("firewall allow page", () => {
  it("shows error when ref query param is missing", async () => {
    await setupPage({
      context,
      path: `/firewall-allow/${AGENT_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByText("Missing agent ID or firewall ref in URL parameters"),
      ).toBeInTheDocument();
    });
  });

  it("shows error for unknown firewall ref", async () => {
    await setupPage({
      context,
      path: `/firewall-allow/${AGENT_ID}?ref=unknown-ref`,
    });

    await waitFor(() => {
      expect(
        screen.getByText(/Unknown firewall: unknown-ref/),
      ).toBeInTheDocument();
    });
  });

  it("renders admin focused view with permission param", async () => {
    mockFirewallRequests();

    await setupPage({
      context,
      path: `/firewall-allow/${AGENT_ID}?ref=github&permission=issues:read`,
    });

    await waitFor(() => {
      expect(screen.getByText("issues:read")).toBeInTheDocument();
    });

    // Admin should see Save button
    expect(screen.getByText("Save")).toBeInTheDocument();
    // Admin should see Allow/Deny toggles
    expect(screen.getByText("Allow")).toBeInTheDocument();
    expect(screen.getByText("Deny")).toBeInTheDocument();
  });

  it("renders admin list view without permission param", async () => {
    mockFirewallRequests();

    await setupPage({
      context,
      path: `/firewall-allow/${AGENT_ID}?ref=github`,
    });

    await waitFor(() => {
      expect(screen.getByText("Permissions")).toBeInTheDocument();
    });

    // Should show Save button
    expect(screen.getByText("Save")).toBeInTheDocument();
  });

  it("renders member focused view with read-only policy and request access button", async () => {
    // Override org to return member role
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
    // Mock agent with the permission denied so Request Access shows
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
          description: null,
          displayName: null,
          sound: null,
          avatarUrl: null,
          firewallPolicies: { github: { "issues:read": "deny" } },
          customSkills: [],
        });
      }),
    );
    mockFirewallRequests();

    await setupPage({
      context,
      path: `/firewall-allow/${AGENT_ID}?ref=github&permission=issues:read`,
    });

    await waitFor(() => {
      expect(screen.getByText("issues:read")).toBeInTheDocument();
    });

    // Member should NOT see Save button
    expect(screen.queryByText("Save")).not.toBeInTheDocument();
    // Member should see Request Access button (since policy is deny)
    expect(screen.getByText("Request Access")).toBeInTheDocument();
  });

  it("renders member list view without permission param", async () => {
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
    mockFirewallRequests();

    await setupPage({
      context,
      path: `/firewall-allow/${AGENT_ID}?ref=github`,
    });

    await waitFor(() => {
      expect(screen.getByText("Permissions")).toBeInTheDocument();
    });

    // Member should NOT see Save button
    expect(screen.queryByText("Save")).not.toBeInTheDocument();
  });

  it("shows blocked request context when method and path are present", async () => {
    mockFirewallRequests();

    await setupPage({
      context,
      path: `/firewall-allow/${AGENT_ID}?ref=github&permission=issues:read&method=GET&path=/repos/owner/repo/pulls`,
    });

    await waitFor(() => {
      expect(screen.getByText("issues:read")).toBeInTheDocument();
    });

    // Should show blocked method+path
    expect(screen.getByText(/GET/)).toBeInTheDocument();
    expect(screen.getByText(/\/repos\/owner\/repo\/pulls/)).toBeInTheDocument();
  });

  it("shows pending access requests for admin", async () => {
    mockFirewallRequests([
      {
        id: "d0000000-0000-4000-a000-000000000001",
        agentId: AGENT_ID,
        firewallRef: "github",
        permission: "issues:read",
        method: null,
        path: null,
        reason: "Need to read issues",
        status: "pending",
        requesterUserId: "user_abc",
        requesterName: "Alice Smith",
        resolvedBy: null,
        resolvedAt: null,
        createdAt: "2026-03-10T00:00:00Z",
      },
    ]);

    await setupPage({
      context,
      path: `/firewall-allow/${AGENT_ID}?ref=github&permission=issues:read`,
    });

    await waitFor(() => {
      expect(screen.getByText("Alice Smith")).toBeInTheDocument();
    });

    expect(screen.getByText(/Need to read issues/)).toBeInTheDocument();
    expect(screen.getByText("Approve")).toBeInTheDocument();
    expect(screen.getByText("Reject")).toBeInTheDocument();
  });

  it("shows connector label in header", async () => {
    mockFirewallRequests();

    await setupPage({
      context,
      path: `/firewall-allow/${AGENT_ID}?ref=github&permission=issues:read`,
    });

    await waitFor(() => {
      expect(screen.getByText(/GitHub Firewall/)).toBeInTheDocument();
    });
  });
});
