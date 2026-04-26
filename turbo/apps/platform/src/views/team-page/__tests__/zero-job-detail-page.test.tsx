import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { zeroTeamContract } from "@vm0/api-contracts/contracts/zero-team";
import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";
import { createMockApi } from "../../../mocks/msw-contract.ts";

const context = testContext();
const mockApi = createMockApi(context);

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";

function mockAgentTeam() {
  server.use(
    mockApi(zeroTeamContract.list, ({ respond }) => {
      return respond(200, [
        {
          id: AGENT_ID,
          displayName: "Test Agent",
          description: "A test agent for unit testing",
          sound: null,
          avatarUrl: null,
          headVersionId: "version_1",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ]);
    }),
    mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
      return respond(200, {
        agentId: AGENT_ID,
        ownerId: "test-user",
        displayName: "Test Agent",
        description: "A test agent for unit testing",
        sound: null,
        avatarUrl: null,
        permissionPolicies: null,
        customSkills: [],
        modelProviderId: null,
        selectedModel: null,
      });
    }),
  );
}

beforeEach(() => {
  server.use(
    http.get("https://example.com/avatar.png", () => {
      return new HttpResponse("avatar", {
        headers: { "Content-Type": "image/png" },
      });
    }),
  );
});

// ---------------------------------------------------------------------------
// ZeroJobDetailPage — renders breadcrumbs, tabs, and content
// ---------------------------------------------------------------------------
describe("zero-job-detail-page", () => {
  it("renders the breadcrumb navigation", async () => {
    mockAgentTeam();
    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}`,
    });

    await waitFor(() => {
      // The breadcrumb Agents link has aria-current="page" distinguish it from sidebar link
      expect(screen.getByRole("link", { name: "Agents", current: "page" })).toBeInTheDocument();
      expect(screen.getByText("Test Agent")).toBeInTheDocument();
    });
  });

  it("renders the authorization tab by default", async () => {
    mockAgentTeam();
    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}`,
    });

    await waitFor(() => {
      // Authorization tab should be visible
      expect(screen.getByRole("tab", { name: /Authorization/i })).toBeInTheDocument();
    });
  });

  it("renders the schedule tab", async () => {
    mockAgentTeam();
    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Scheduled/i })).toBeInTheDocument();
    });
  });

  it("shows agent name in header", async () => {
    mockAgentTeam();
    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByText("Test Agent")).toBeInTheDocument();
    });
  });

  it("shows agent description when available", async () => {
    mockAgentTeam();
    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByText("A test agent for unit testing")).toBeInTheDocument();
    });
  });

  it("renders the Chat button", async () => {
    mockAgentTeam();
    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Chat with Test Agent/i })).toBeInTheDocument();
    });
  });
});
