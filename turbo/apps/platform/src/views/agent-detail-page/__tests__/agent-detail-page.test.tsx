import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { describe, expect, it, vi } from "vitest";
import { screen, within, fireEvent } from "@testing-library/react";
import { pathname$ } from "../../../signals/route.ts";
import { server } from "../../../mocks/server.ts";
import { http, HttpResponse } from "msw";
import { FeatureSwitchKey } from "@vm0/core";

const context = testContext();

function mockAgentDetailAPI(options?: {
  name?: string;
  description?: string;
  instructions?: { content: string | null; filename: string | null };
  error?: boolean;
}) {
  const name = options?.name ?? "my-agent";
  const description = options?.description ?? "A test agent";
  const instructions = options?.instructions ?? {
    content: "# Instructions\nDo stuff",
    filename: "instructions.md",
  };

  server.use(
    http.get("/api/agent/composes", ({ request }) => {
      const url = new URL(request.url);
      const queryName = url.searchParams.get("name");

      if (options?.error) {
        return new HttpResponse(null, { status: 500 });
      }

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
              description,
              framework: "claude-code",
            },
          },
        },
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      });
    }),
    http.get("/api/agent/composes/:id/instructions", () => {
      return HttpResponse.json(instructions);
    }),
  );
}

describe("agent detail page", () => {
  it("should redirect to /agents when feature flag is disabled", async () => {
    await setupPage({
      context,
      path: "/agents/my-agent",
    });

    expect(context.store.get(pathname$)).toBe("/agents");
  });

  it("should render agent detail when feature flag is enabled", async () => {
    mockAgentDetailAPI();

    await setupPage({
      context,
      path: "/agents/my-agent",
      featureSwitches: { [FeatureSwitchKey.AgentDetailPage]: true },
    });

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "my-agent" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("A test agent")).toBeInTheDocument();
  });

  it("should show error state when API fails", async () => {
    mockAgentDetailAPI({ error: true });

    await setupPage({
      context,
      path: "/agents/my-agent",
      featureSwitches: { [FeatureSwitchKey.AgentDetailPage]: true },
    });

    await vi.waitFor(() => {
      const errorEl = screen.getByText(/failed to fetch/i);
      expect(errorEl).toHaveClass("text-destructive");
    });
  });

  it("should show instructions with markdown content for owned agents", async () => {
    mockAgentDetailAPI({
      instructions: {
        content: "# My Instructions",
        filename: "instructions.md",
      },
    });

    await setupPage({
      context,
      path: "/agents/my-agent",
      featureSwitches: { [FeatureSwitchKey.AgentDetailPage]: true },
    });

    await vi.waitFor(() => {
      expect(screen.getByText("Agent instructions")).toBeInTheDocument();
    });

    // Default view mode is "preview", switch to "markdown" to see raw text
    fireEvent.click(screen.getByRole("tab", { name: "Markdown" }));
    expect(screen.getByText("# My Instructions")).toBeInTheDocument();
  });

  it("should show disabled Run button for unimplemented features", async () => {
    mockAgentDetailAPI();

    await setupPage({
      context,
      path: "/agents/my-agent",
      featureSwitches: { [FeatureSwitchKey.AgentDetailPage]: true },
    });

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "my-agent" }),
      ).toBeInTheDocument();
    });

    const runButton = screen.getByRole("button", { name: /Run/ });
    expect(runButton).toBeDisabled();
  });

  it("should show breadcrumb with agents link and agent name", async () => {
    mockAgentDetailAPI();

    await setupPage({
      context,
      path: "/agents/my-agent",
      featureSwitches: { [FeatureSwitchKey.AgentDetailPage]: true },
    });

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "my-agent" }),
      ).toBeInTheDocument();
    });

    // Breadcrumb should contain "Agents" link
    const nav = screen.getByRole("navigation");
    expect(within(nav).getByText("Agents")).toBeInTheDocument();
  });
});
