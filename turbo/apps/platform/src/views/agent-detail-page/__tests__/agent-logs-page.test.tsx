import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { pathname$ } from "../../../signals/route.ts";
import { server } from "../../../mocks/server.ts";
import { http, HttpResponse } from "msw";
import { FeatureSwitchKey } from "@vm0/core";

const context = testContext();

function mockAgentDetailAPI(options?: { name?: string }) {
  const name = options?.name ?? "my-agent";

  server.use(
    http.get("/api/agent/composes", ({ request }) => {
      const url = new URL(request.url);
      const queryName = url.searchParams.get("name");

      if (queryName !== name) {
        return new HttpResponse(null, { status: 404 });
      }

      return HttpResponse.json({
        id: "compose_1",
        name,
        headVersionId: "version_1",
        content: {
          version: "1",
          agents: {
            [name]: {
              description: "A test agent",
              framework: "claude-code",
            },
          },
        },
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      });
    }),
    http.get("/api/agent/composes/:id/instructions", () => {
      return HttpResponse.json({ content: null, filename: null });
    }),
  );
}

function mockLogsAPI(options?: {
  agentName?: string;
  data?: unknown[];
  hasMore?: boolean;
  totalPages?: number;
}) {
  const agentName = options?.agentName ?? "my-agent";
  const hasMore = options?.hasMore ?? false;
  const totalPages = options?.totalPages ?? 1;
  const data = options?.data ?? [
    {
      id: "run_1",
      sessionId: "session_1",
      agentName,
      framework: "claude-code",
      status: "completed",
      createdAt: "2024-06-15T10:30:00Z",
    },
    {
      id: "run_2",
      sessionId: null,
      agentName,
      framework: "claude-code",
      status: "running",
      createdAt: "2024-06-15T09:00:00Z",
    },
  ];

  server.use(
    http.get("/api/platform/logs", ({ request }) => {
      const url = new URL(request.url);
      const queryAgent = url.searchParams.get("agent");

      if (queryAgent !== agentName) {
        return HttpResponse.json({
          data: [],
          pagination: { hasMore: false, nextCursor: null, totalPages: 1 },
        });
      }

      return HttpResponse.json({
        data,
        pagination: {
          hasMore,
          nextCursor: hasMore ? "cursor_1" : null,
          totalPages,
        },
      });
    }),
  );
}

describe("agent logs page", () => {
  it("should redirect to /agents when feature flag is disabled", async () => {
    await setupPage({
      context,
      path: "/agents/my-agent/logs",
    });

    expect(context.store.get(pathname$)).toBe("/agents");
  });

  it("should render page header and logs table", async () => {
    mockAgentDetailAPI();
    mockLogsAPI();

    await setupPage({
      context,
      path: "/agents/my-agent/logs",
      featureSwitches: { [FeatureSwitchKey.AgentDetailPage]: true },
    });

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "my-agent" }),
      ).toBeInTheDocument();
    });

    // Should show table headers
    expect(screen.getByText("Run ID")).toBeInTheDocument();
    expect(screen.getByText("Session ID")).toBeInTheDocument();
    expect(screen.getByText("Model")).toBeInTheDocument();
    expect(screen.getByText("Generate time")).toBeInTheDocument();

    // Should show run data
    expect(screen.getByText("run_1")).toBeInTheDocument();
    expect(screen.getByText("session_1")).toBeInTheDocument();
    expect(screen.getByText("run_2")).toBeInTheDocument();
  });

  it("should show empty state when no logs exist", async () => {
    mockAgentDetailAPI();
    mockLogsAPI({ data: [] });

    await setupPage({
      context,
      path: "/agents/my-agent/logs",
      featureSwitches: { [FeatureSwitchKey.AgentDetailPage]: true },
    });

    await vi.waitFor(() => {
      expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
    });
  });

  it("should show three-level breadcrumb", async () => {
    mockAgentDetailAPI();
    mockLogsAPI();

    await setupPage({
      context,
      path: "/agents/my-agent/logs",
      featureSwitches: { [FeatureSwitchKey.AgentDetailPage]: true },
    });

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "my-agent" }),
      ).toBeInTheDocument();
    });

    const nav = screen.getByRole("navigation");
    expect(within(nav).getByText("Agents")).toBeInTheDocument();
    expect(within(nav).getByText("my-agent")).toBeInTheDocument();
    expect(within(nav).getByText("Logs")).toBeInTheDocument();
  });

  it("should show pagination controls", async () => {
    mockAgentDetailAPI();
    mockLogsAPI({ hasMore: true, totalPages: 3 });

    await setupPage({
      context,
      path: "/agents/my-agent/logs",
      featureSwitches: { [FeatureSwitchKey.AgentDetailPage]: true },
    });

    await vi.waitFor(() => {
      expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
    });

    expect(screen.getByText("Rows per page")).toBeInTheDocument();
  });

  it("should show dash for null session ID", async () => {
    mockAgentDetailAPI();
    mockLogsAPI({
      data: [
        {
          id: "run_1",
          sessionId: null,
          agentName: "my-agent",
          framework: "claude-code",
          status: "completed",
          createdAt: "2024-06-15T10:30:00Z",
        },
      ],
    });

    await setupPage({
      context,
      path: "/agents/my-agent/logs",
      featureSwitches: { [FeatureSwitchKey.AgentDetailPage]: true },
    });

    await vi.waitFor(() => {
      expect(screen.getByText("run_1")).toBeInTheDocument();
    });

    expect(screen.getByText("-")).toBeInTheDocument();
  });
});
