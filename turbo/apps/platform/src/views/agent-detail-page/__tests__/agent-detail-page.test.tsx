import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { describe, expect, it, vi } from "vitest";
import { screen, within, fireEvent } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { http, HttpResponse } from "msw";

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
  it("should render agent detail when feature flag is enabled", async () => {
    mockAgentDetailAPI();

    await setupPage({
      context,
      path: "/agents/my-agent",
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
    });

    await vi.waitFor(() => {
      expect(screen.getByText("Agent instructions")).toBeInTheDocument();
    });

    // Default view mode is "preview", switch to "markdown" to see raw text
    fireEvent.click(screen.getByRole("tab", { name: "Markdown" }));
    expect(screen.getByText("# My Instructions")).toBeInTheDocument();
  });

  it("should show enabled Run button", async () => {
    mockAgentDetailAPI();

    await setupPage({
      context,
      path: "/agents/my-agent",
    });

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "my-agent" }),
      ).toBeInTheDocument();
    });

    const runButton = screen.getByRole("button", { name: /Run/ });
    expect(runButton).toBeEnabled();
  });

  it("should show breadcrumb with agents link and agent name", async () => {
    mockAgentDetailAPI();

    await setupPage({
      context,
      path: "/agents/my-agent",
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

  it("should show textarea for owner in markdown mode", async () => {
    mockAgentDetailAPI({
      instructions: {
        content: "# Editable",
        filename: "instructions.md",
      },
    });

    await setupPage({
      context,
      path: "/agents/my-agent",
    });

    await vi.waitFor(() => {
      expect(screen.getByText("Agent instructions")).toBeInTheDocument();
    });

    // Switch to markdown mode
    fireEvent.click(screen.getByRole("tab", { name: "Markdown" }));

    // Owner should see a textarea
    const textarea = screen.getByRole("textbox");
    expect(textarea).toBeInTheDocument();
    expect(textarea).toHaveValue("# Editable");
  });

  it("should show Save/Discard when content is edited", async () => {
    mockAgentDetailAPI({
      instructions: {
        content: "# Original",
        filename: "instructions.md",
      },
    });

    await setupPage({
      context,
      path: "/agents/my-agent",
    });

    await vi.waitFor(() => {
      expect(screen.getByText("Agent instructions")).toBeInTheDocument();
    });

    // Switch to markdown mode and edit
    fireEvent.click(screen.getByRole("tab", { name: "Markdown" }));
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "# Modified" } });

    // Save and Discard buttons should appear
    await vi.waitFor(() => {
      expect(screen.getByRole("button", { name: "Build" })).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Discard" }),
      ).toBeInTheDocument();
    });
  });

  it("should discard edits on Discard", async () => {
    mockAgentDetailAPI({
      instructions: {
        content: "# Original",
        filename: "instructions.md",
      },
    });

    await setupPage({
      context,
      path: "/agents/my-agent",
    });

    await vi.waitFor(() => {
      expect(screen.getByText("Agent instructions")).toBeInTheDocument();
    });

    // Switch to markdown mode, edit, then discard
    fireEvent.click(screen.getByRole("tab", { name: "Markdown" }));
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "# Modified" } });

    await vi.waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Discard" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    // Should revert to original
    await vi.waitFor(() => {
      expect(screen.getByRole("textbox")).toHaveValue("# Original");
    });

    // Save/Discard should disappear
    expect(screen.queryByRole("button", { name: "Build" })).toBeNull();
  });

  it("should initialize view mode from query param", async () => {
    mockAgentDetailAPI({
      instructions: {
        content: "# From URL",
        filename: "instructions.md",
      },
    });

    await setupPage({
      context,
      path: "/agents/my-agent?view=markdown",
    });

    await vi.waitFor(() => {
      expect(screen.getByText("Agent instructions")).toBeInTheDocument();
    });

    // Should start in markdown mode (from ?view=markdown), showing textarea
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("should show Chat button for owned agents", async () => {
    mockAgentDetailAPI();

    await setupPage({
      context,
      path: "/agents/my-agent",
    });

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "my-agent" }),
      ).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: "Chat" })).toBeInTheDocument();
  });

  it("should open chat panel when Chat button is clicked", async () => {
    mockAgentDetailAPI();

    await setupPage({
      context,
      path: "/agents/my-agent",
    });

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "my-agent" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Chat" }));

    await vi.waitFor(() => {
      expect(
        screen.getByText("Send a message to start chatting"),
      ).toBeInTheDocument();
    });
  });

  it("should close chat panel when close button is clicked", async () => {
    mockAgentDetailAPI();

    await setupPage({
      context,
      path: "/agents/my-agent",
    });

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "my-agent" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Chat" }));

    await vi.waitFor(() => {
      expect(
        screen.getByText("Send a message to start chatting"),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Close chat panel" }));

    await vi.waitFor(() => {
      expect(screen.queryByText("Send a message to start chatting")).toBeNull();
    });
  });

  it("should show user message bubble after sending a message", async () => {
    mockAgentDetailAPI();

    // Mock run creation and polling
    server.use(
      http.post("/api/agent/runs", () => {
        return HttpResponse.json({ runId: "run_123" });
      }),
      http.get("/api/agent/runs/:runId/telemetry/agent", () => {
        return HttpResponse.json({ events: [], hasMore: false });
      }),
      http.get("/api/platform/logs/:runId", () => {
        return HttpResponse.json({
          id: "run_123",
          status: "running",
          createdAt: "2024-01-01T00:00:00Z",
        });
      }),
    );

    await setupPage({
      context,
      path: "/agents/my-agent",
    });

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "my-agent" }),
      ).toBeInTheDocument();
    });

    // Open chat panel
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));

    await vi.waitFor(() => {
      expect(
        screen.getByText("Send a message to start chatting"),
      ).toBeInTheDocument();
    });

    // Type a message and send
    const textarea = screen.getByPlaceholderText("Type a message...");
    fireEvent.change(textarea, { target: { value: "Help me build my agent" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    // User message bubble should appear
    await vi.waitFor(() => {
      expect(screen.getByText("Help me build my agent")).toBeInTheDocument();
    });
  });

  it("should show error when chat message send fails", async () => {
    mockAgentDetailAPI();

    // Mock run API to fail
    server.use(
      http.post("/api/agent/runs", () => {
        return HttpResponse.json({ message: "Run failed" }, { status: 500 });
      }),
    );

    await setupPage({
      context,
      path: "/agents/my-agent",
    });

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "my-agent" }),
      ).toBeInTheDocument();
    });

    // Open chat panel
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));

    await vi.waitFor(() => {
      expect(
        screen.getByText("Send a message to start chatting"),
      ).toBeInTheDocument();
    });

    // Type a message and send
    const textarea = screen.getByPlaceholderText("Type a message...");
    fireEvent.change(textarea, { target: { value: "Hello" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    // Error message should appear
    await vi.waitFor(() => {
      expect(screen.getByText(/Run failed/)).toBeInTheDocument();
    });
  });

  it("should not show Chat button for shared (non-owner) agents", async () => {
    server.use(
      http.get("/api/agent/composes", ({ request }) => {
        const url = new URL(request.url);
        const queryName = url.searchParams.get("name");
        if (queryName !== "shared-agent") {
          return new HttpResponse(null, { status: 404 });
        }
        return HttpResponse.json({
          id: "compose_2",
          name: "shared-agent",
          headVersionId: "version_1",
          content: {
            version: "1",
            agents: {
              "shared-agent": {
                description: "A shared agent",
                framework: "claude-code",
              },
            },
          },
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        });
      }),
      http.get("/api/agent/composes/:id/instructions", () => {
        return HttpResponse.json({
          content: "# Shared",
          filename: "instructions.md",
        });
      }),
    );

    await setupPage({
      context,
      path: `/agents/${encodeURIComponent("other-org/shared-agent")}`,
    });

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "shared-agent" }),
      ).toBeInTheDocument();
    });

    expect(screen.queryByRole("button", { name: "Chat" })).toBeNull();
  });

  it("should propagate inline run error from polling", async () => {
    mockAgentDetailAPI();

    // Mock run creation, then return failed status with error
    server.use(
      http.post("/api/agent/runs", () => {
        return HttpResponse.json({ runId: "run_err" });
      }),
      http.get("/api/agent/runs/:runId/telemetry/agent", () => {
        return HttpResponse.json({ events: [], hasMore: false });
      }),
      http.get("/api/platform/logs/:runId", () => {
        return HttpResponse.json({
          id: "run_err",
          status: "failed",
          error: "Sandbox crashed unexpectedly",
          createdAt: "2024-01-01T00:00:00Z",
        });
      }),
    );

    await setupPage({
      context,
      path: "/agents/my-agent",
    });

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "my-agent" }),
      ).toBeInTheDocument();
    });

    // Trigger an inline run via the run dialog mock
    // We simulate by importing and calling startInlineRun$ directly
    const { startInlineRun$ } = await import(
      "../../../signals/agent-detail/inline-run.ts"
    );
    const { set } = context.store;
    set(startInlineRun$, "run_err");

    // Error should propagate and display in the inline run panel
    await vi.waitFor(() => {
      expect(
        screen.getByText("Sandbox crashed unexpectedly"),
      ).toBeInTheDocument();
    });
  });

  it("should fetch session list when chat panel opens", async () => {
    mockAgentDetailAPI();

    server.use(
      http.get("/api/agent/sessions", () => {
        return HttpResponse.json({
          sessions: [
            {
              id: "session_1",
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-02T00:00:00Z",
              messageCount: 3,
              preview: "Help me build my agent",
            },
            {
              id: "session_2",
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T12:00:00Z",
              messageCount: 1,
              preview: "What is this agent?",
            },
          ],
        });
      }),
    );

    await setupPage({
      context,
      path: "/agents/my-agent",
    });

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "my-agent" }),
      ).toBeInTheDocument();
    });

    // Open chat panel
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));

    await vi.waitFor(() => {
      expect(
        screen.getByText("Send a message to start chatting"),
      ).toBeInTheDocument();
    });

    // Open session dropdown
    fireEvent.click(screen.getByRole("button", { name: "Session history" }));

    // Session items should appear
    await vi.waitFor(() => {
      expect(screen.getByText("Help me build my agent")).toBeInTheDocument();
      expect(screen.getByText("What is this agent?")).toBeInTheDocument();
    });
  });

  it("should switch to a different session and load its messages", async () => {
    mockAgentDetailAPI();

    server.use(
      http.get("/api/agent/sessions", () => {
        return HttpResponse.json({
          sessions: [
            {
              id: "session_old",
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T12:00:00Z",
              messageCount: 2,
              preview: "Previous conversation",
            },
          ],
        });
      }),
      http.get("/api/agent/sessions/:id", () => {
        return HttpResponse.json({
          id: "session_old",
          agentComposeId: "compose_1",
          conversationId: "conv_1",
          artifactName: null,
          secretNames: null,
          chatMessages: [
            {
              role: "user",
              content: "Previous conversation",
              createdAt: "2024-01-01T10:00:00Z",
            },
            {
              role: "assistant",
              content: "Here is what I found",
              runId: "run_old",
              createdAt: "2024-01-01T10:01:00Z",
            },
          ],
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T12:00:00Z",
        });
      }),
    );

    await setupPage({
      context,
      path: "/agents/my-agent",
    });

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "my-agent" }),
      ).toBeInTheDocument();
    });

    // Open chat panel
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));

    await vi.waitFor(() => {
      expect(
        screen.getByText("Send a message to start chatting"),
      ).toBeInTheDocument();
    });

    // Open session dropdown and click session
    fireEvent.click(screen.getByRole("button", { name: "Session history" }));

    await vi.waitFor(() => {
      expect(screen.getByText("Previous conversation")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Previous conversation"));

    // Messages from the old session should now appear in the chat
    await vi.waitFor(() => {
      expect(screen.getByText("Here is what I found")).toBeInTheDocument();
    });
  });

  it("should clear messages when starting a new session", async () => {
    mockAgentDetailAPI();

    server.use(
      http.get("/api/agent/sessions", () => {
        return HttpResponse.json({
          sessions: [
            {
              id: "session_existing",
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T12:00:00Z",
              messageCount: 2,
              preview: "Old chat",
            },
          ],
        });
      }),
      http.get("/api/agent/sessions/:id", () => {
        return HttpResponse.json({
          id: "session_existing",
          agentComposeId: "compose_1",
          conversationId: "conv_1",
          artifactName: null,
          secretNames: null,
          chatMessages: [
            {
              role: "user",
              content: "Old chat",
              createdAt: "2024-01-01T10:00:00Z",
            },
            {
              role: "assistant",
              content: "Old response",
              createdAt: "2024-01-01T10:01:00Z",
            },
          ],
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T12:00:00Z",
        });
      }),
    );

    await setupPage({
      context,
      path: "/agents/my-agent",
    });

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "my-agent" }),
      ).toBeInTheDocument();
    });

    // Open chat panel
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));

    await vi.waitFor(() => {
      expect(
        screen.getByText("Send a message to start chatting"),
      ).toBeInTheDocument();
    });

    // Switch to old session first
    fireEvent.click(screen.getByRole("button", { name: "Session history" }));

    await vi.waitFor(() => {
      expect(screen.getByText("Old chat")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Old chat"));

    await vi.waitFor(() => {
      expect(screen.getByText("Old response")).toBeInTheDocument();
    });

    // Click "New chat" button
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));

    // Messages should be cleared
    await vi.waitFor(() => {
      expect(
        screen.getByText("Send a message to start chatting"),
      ).toBeInTheDocument();
    });
  });

  it("should show empty state in session dropdown when no sessions exist", async () => {
    mockAgentDetailAPI();

    server.use(
      http.get("/api/agent/sessions", () => {
        return HttpResponse.json({ sessions: [] });
      }),
    );

    await setupPage({
      context,
      path: "/agents/my-agent",
    });

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "my-agent" }),
      ).toBeInTheDocument();
    });

    // Open chat panel
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));

    await vi.waitFor(() => {
      expect(
        screen.getByText("Send a message to start chatting"),
      ).toBeInTheDocument();
    });

    // Open session dropdown
    fireEvent.click(screen.getByRole("button", { name: "Session history" }));

    // Should show empty state
    await vi.waitFor(() => {
      expect(screen.getByText("No previous sessions")).toBeInTheDocument();
    });
  });

  it("should show read-only pre for shared (non-owner) agents", async () => {
    // Shared agent path has org/name format
    server.use(
      http.get("/api/agent/composes", ({ request }) => {
        const url = new URL(request.url);
        const queryName = url.searchParams.get("name");
        if (queryName !== "shared-agent") {
          return new HttpResponse(null, { status: 404 });
        }
        return HttpResponse.json({
          id: "compose_2",
          name: "shared-agent",
          headVersionId: "version_1",
          content: {
            version: "1",
            agents: {
              "shared-agent": {
                description: "A shared agent",
                framework: "claude-code",
              },
            },
          },
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        });
      }),
      http.get("/api/agent/composes/:id/instructions", () => {
        return HttpResponse.json({
          content: "# Shared Content",
          filename: "instructions.md",
        });
      }),
    );

    await setupPage({
      context,
      path: `/agents/${encodeURIComponent("other-org/shared-agent")}`,
    });

    await vi.waitFor(() => {
      expect(screen.getByText("Agent instructions")).toBeInTheDocument();
    });

    // Switch to markdown mode — should be read-only (pre, not textarea)
    fireEvent.click(screen.getByRole("tab", { name: "Markdown" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("# Shared Content")).toBeInTheDocument();
  });
});
