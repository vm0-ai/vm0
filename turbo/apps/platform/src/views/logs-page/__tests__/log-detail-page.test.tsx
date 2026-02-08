import { describe, it, expect } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { pathname$ } from "../../../signals/route.ts";
import { screen, waitFor, within } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { http, HttpResponse } from "msw";
import { userEvent } from "@testing-library/user-event";

const context = testContext();
const user = userEvent.setup();

// Factory function for default agent events response
function createDefaultAgentEventsResponse() {
  return {
    events: [
      {
        sequenceNumber: 1,
        eventType: "assistant",
        eventData: {
          message: {
            content: [{ type: "text", text: "Hello" }],
            role: "assistant",
          },
        },
        createdAt: "2024-01-01T00:00:02Z",
      },
    ],
    hasMore: false,
    framework: "claude-code",
  };
}

describe("log detail page", () => {
  it("should render the log detail page with breadcrumb", async () => {
    server.use(
      http.get("*/api/platform/logs/:id", () => {
        return HttpResponse.json({
          id: "test-run-123",
          sessionId: "session-456",
          agentName: "Test Agent",
          framework: "claude-code",
          status: "completed",
          prompt: "Test prompt",
          error: null,
          createdAt: "2024-01-01T00:00:00Z",
          startedAt: "2024-01-01T00:00:01Z",
          completedAt: "2024-01-01T00:00:10Z",
          artifact: { name: "test-artifact", version: "1.0.0" },
        });
      }),
      http.get("*/api/agent/runs/:id/telemetry/agent", () => {
        return HttpResponse.json(createDefaultAgentEventsResponse());
      }),
    );

    await setupPage({
      context,
      path: "/logs/test-run-123",
    });

    // Verify breadcrumb shows Run ID with full ID
    await waitFor(() => {
      expect(screen.getByText("Run ID - test-run-123")).toBeInTheDocument();
    });
    expect(context.store.get(pathname$)).toBe("/logs/test-run-123");
  });

  it("should display run details in inline info card", async () => {
    server.use(
      http.get("*/api/platform/logs/:id", () => {
        return HttpResponse.json({
          id: "run-abc-123",
          sessionId: "session-xyz-789",
          agentName: "My Test Agent",
          framework: "openai",
          status: "completed",
          prompt: "Do something",
          error: null,
          createdAt: "2024-01-15T10:30:00Z",
          startedAt: "2024-01-15T10:30:01Z",
          completedAt: "2024-01-15T10:30:15Z",
          artifact: { name: "my-artifact", version: "2.0.0" },
        });
      }),
      http.get("*/api/agent/runs/:id/telemetry/agent", () => {
        return HttpResponse.json(createDefaultAgentEventsResponse());
      }),
    );

    await setupPage({
      context,
      path: "/logs/run-abc-123",
    });

    // Wait for detail to load - all info is now inline in the info card
    // Note: Both desktop and mobile info cards are rendered (CSS controls visibility)
    // so we use getAllByText to handle multiple matches
    await waitFor(() => {
      expect(screen.getAllByText("My Test Agent").length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText("Done").length).toBeGreaterThan(0); // Status badge
    expect(screen.getAllByText("openai").length).toBeGreaterThan(0); // Framework
    expect(screen.getByText("Run ID")).toBeInTheDocument(); // Run label (desktop only)
    expect(screen.getByText("Session ID")).toBeInTheDocument(); // Session label (desktop only)
  });

  it("should display user prompt when present", async () => {
    server.use(
      http.get("*/api/platform/logs/:id", () => {
        return HttpResponse.json({
          id: "run-prompt-test",
          sessionId: null,
          agentName: "Prompt Agent",
          framework: "claude-code",
          status: "completed",
          prompt: "Summarize the quarterly report",
          error: null,
          createdAt: "2024-01-01T00:00:00Z",
          startedAt: "2024-01-01T00:00:01Z",
          completedAt: "2024-01-01T00:00:10Z",
          artifact: { name: null, version: null },
        });
      }),
      http.get("*/api/agent/runs/:id/telemetry/agent", () => {
        return HttpResponse.json(createDefaultAgentEventsResponse());
      }),
    );

    await setupPage({
      context,
      path: "/logs/run-prompt-test",
    });

    await waitFor(() => {
      expect(screen.getByText("Prompt")).toBeInTheDocument();
    });
    expect(
      screen.getByText("Summarize the quarterly report"),
    ).toBeInTheDocument();
  });

  it("should not display prompt section when prompt is empty", async () => {
    server.use(
      http.get("*/api/platform/logs/:id", () => {
        return HttpResponse.json({
          id: "run-no-prompt",
          sessionId: null,
          agentName: "No Prompt Agent",
          framework: "claude-code",
          status: "completed",
          prompt: "",
          error: null,
          createdAt: "2024-01-01T00:00:00Z",
          startedAt: "2024-01-01T00:00:01Z",
          completedAt: "2024-01-01T00:00:10Z",
          artifact: { name: null, version: null },
        });
      }),
      http.get("*/api/agent/runs/:id/telemetry/agent", () => {
        return HttpResponse.json(createDefaultAgentEventsResponse());
      }),
    );

    await setupPage({
      context,
      path: "/logs/run-no-prompt",
    });

    // Wait for page to load
    await waitFor(() => {
      expect(screen.getAllByText("No Prompt Agent").length).toBeGreaterThan(0);
    });

    // Prompt section should not be rendered
    expect(screen.queryByText("Prompt")).not.toBeInTheDocument();
  });

  it("should display duration correctly", async () => {
    server.use(
      http.get("*/api/platform/logs/:id", () => {
        return HttpResponse.json({
          id: "run-duration-test",
          sessionId: null,
          agentName: "Duration Agent",
          framework: "claude-code",
          status: "completed",
          prompt: "Test",
          error: null,
          createdAt: "2024-01-01T00:00:00Z",
          startedAt: "2024-01-01T00:00:00Z",
          completedAt: "2024-01-01T00:01:30Z", // 1 minute 30 seconds
          artifact: { name: null, version: null },
        });
      }),
      http.get("*/api/agent/runs/:id/telemetry/agent", () => {
        return HttpResponse.json(createDefaultAgentEventsResponse());
      }),
    );

    await setupPage({
      context,
      path: "/logs/run-duration-test",
    });

    // Both desktop and mobile info cards show duration
    await waitFor(() => {
      expect(screen.getAllByText("1m 30s").length).toBeGreaterThan(0);
    });
  });

  it("should not display session when sessionId is null", async () => {
    server.use(
      http.get("*/api/platform/logs/:id", () => {
        return HttpResponse.json({
          id: "run-no-session",
          sessionId: null,
          agentName: "No Session Agent",
          framework: "claude-code",
          status: "pending",
          prompt: "Test",
          error: null,
          createdAt: "2024-01-01T00:00:00Z",
          startedAt: null,
          completedAt: null,
          artifact: { name: null, version: null },
        });
      }),
      http.get("*/api/agent/runs/:id/telemetry/agent", () => {
        return HttpResponse.json(createDefaultAgentEventsResponse());
      }),
    );

    await setupPage({
      context,
      path: "/logs/run-no-session",
    });

    // Both desktop and mobile info cards show agent name
    await waitFor(() => {
      expect(screen.getAllByText("No Session Agent").length).toBeGreaterThan(0);
    });

    // Session label should not be shown when sessionId is null
    expect(screen.queryByText("Session:")).not.toBeInTheDocument();
  });

  it("should display error message for failed runs", async () => {
    server.use(
      http.get("*/api/platform/logs/:id", () => {
        return HttpResponse.json({
          id: "run-failed",
          sessionId: null,
          agentName: "Failed Agent",
          framework: "claude-code",
          status: "failed",
          prompt: "Test",
          error: "Connection timeout after 30 seconds",
          createdAt: "2024-01-01T00:00:00Z",
          startedAt: "2024-01-01T00:00:01Z",
          completedAt: null,
          artifact: { name: null, version: null },
        });
      }),
      http.get("*/api/agent/runs/:id/telemetry/agent", () => {
        return HttpResponse.json(createDefaultAgentEventsResponse());
      }),
    );

    await setupPage({
      context,
      path: "/logs/run-failed",
    });

    // Both desktop and mobile info cards show status badge
    await waitFor(() => {
      expect(screen.getAllByText("Failed").length).toBeGreaterThan(0);
    });
    expect(
      screen.getByText("Connection timeout after 30 seconds"),
    ).toBeInTheDocument();
  });

  it("should display raw data card with agent events", async () => {
    server.use(
      http.get("*/api/platform/logs/:id", () => {
        return HttpResponse.json({
          id: "run-raw-data",
          sessionId: "session-raw",
          agentName: "Raw Data Agent",
          framework: "claude-code",
          status: "completed",
          prompt: "Generate something",
          error: null,
          createdAt: "2024-01-01T00:00:00Z",
          startedAt: "2024-01-01T00:00:01Z",
          completedAt: "2024-01-01T00:00:10Z",
          artifact: { name: null, version: null },
        });
      }),
      http.get("*/api/agent/runs/:id/telemetry/agent", () => {
        return HttpResponse.json({
          events: [
            {
              sequenceNumber: 1,
              eventType: "assistant",
              eventData: {
                message: {
                  content: [{ type: "text", text: "Starting task" }],
                  role: "assistant",
                },
              },
              createdAt: "2024-01-01T00:00:02Z",
            },
            {
              sequenceNumber: 2,
              eventType: "assistant",
              eventData: {
                message: {
                  content: [
                    {
                      type: "tool_use",
                      id: "tool-1",
                      name: "Read",
                      input: { file_path: "/test.txt" },
                    },
                  ],
                  role: "assistant",
                },
              },
              createdAt: "2024-01-01T00:00:03Z",
            },
          ],
          hasMore: false,
          framework: "claude-code",
        });
      }),
    );

    await setupPage({
      context,
      path: "/logs/run-raw-data",
    });

    await waitFor(() => {
      expect(screen.getByText("Agent events")).toBeInTheDocument();
    });

    // Verify the events are rendered (in formatted view)
    await waitFor(() => {
      expect(screen.getByText(/Starting task/)).toBeInTheDocument();
    });
  });

  it("should navigate to logs list via breadcrumb", async () => {
    server.use(
      http.get("*/api/platform/logs", () => {
        return HttpResponse.json({
          data: [],
          pagination: { hasMore: false, nextCursor: null },
        });
      }),
      http.get("*/api/platform/logs/:id", () => {
        return HttpResponse.json({
          id: "run-back-test",
          sessionId: null,
          agentName: "Back Test Agent",
          framework: "claude-code",
          status: "completed",
          prompt: "Test",
          error: null,
          createdAt: "2024-01-01T00:00:00Z",
          startedAt: null,
          completedAt: null,
          artifact: { name: null, version: null },
        });
      }),
      http.get("*/api/agent/runs/:id/telemetry/agent", () => {
        return HttpResponse.json(createDefaultAgentEventsResponse());
      }),
    );

    await setupPage({
      context,
      path: "/logs/run-back-test",
    });

    // Wait for page to load - both desktop and mobile info cards show agent name
    await waitFor(() => {
      expect(screen.getAllByText("Back Test Agent").length).toBeGreaterThan(0);
    });

    // Click Logs link in breadcrumb (use within to scope to nav element)
    const breadcrumbNav = screen.getByRole("navigation");
    await user.click(within(breadcrumbNav).getByText("Logs"));

    // Should navigate to logs list
    await waitFor(() => {
      expect(context.store.get(pathname$)).toBe("/logs");
    });
  });

  it("should handle API error gracefully", async () => {
    server.use(
      http.get("*/api/platform/logs/:id", () => {
        return HttpResponse.json(
          { error: { message: "Run not found", code: "NOT_FOUND" } },
          { status: 404 },
        );
      }),
      http.get("*/api/agent/runs/:id/telemetry/agent", () => {
        return HttpResponse.json(createDefaultAgentEventsResponse());
      }),
    );

    await setupPage({
      context,
      path: "/logs/non-existent-run",
    });

    await waitFor(() => {
      expect(screen.getByText(/Hmm, couldn't load that/)).toBeInTheDocument();
    });
  });

  it("should display no events message when events array is empty", async () => {
    server.use(
      http.get("*/api/platform/logs/:id", () => {
        return HttpResponse.json({
          id: "run-no-events",
          sessionId: null,
          agentName: "No Events Agent",
          framework: "claude-code",
          status: "pending",
          prompt: "Test",
          error: null,
          createdAt: "2024-01-01T00:00:00Z",
          startedAt: null,
          completedAt: null,
          artifact: { name: null, version: null },
        });
      }),
      http.get("*/api/agent/runs/:id/telemetry/agent", () => {
        return HttpResponse.json({
          events: [],
          hasMore: false,
          framework: "claude-code",
        });
      }),
    );

    await setupPage({
      context,
      path: "/logs/run-no-events",
    });

    await waitFor(() => {
      expect(screen.getByText("No events available")).toBeInTheDocument();
    });
  });

  describe("search functionality", () => {
    function createSearchTestResponse() {
      // User prompts are displayed in a separate section above the events card,
      // so we use 3 assistant messages to test the search functionality
      // with 3 "world" matches
      return {
        events: [
          {
            sequenceNumber: 1,
            eventType: "assistant",
            eventData: {
              message: {
                content: [{ type: "text", text: "Hello world from assistant" }],
                role: "assistant",
              },
            },
            createdAt: "2024-01-01T00:00:02Z",
          },
          {
            sequenceNumber: 2,
            eventType: "assistant",
            eventData: {
              message: {
                content: [
                  { type: "text", text: "Another message with world keyword" },
                ],
                role: "assistant",
              },
            },
            createdAt: "2024-01-01T00:00:03Z",
          },
          {
            sequenceNumber: 3,
            eventType: "assistant",
            eventData: {
              message: {
                content: [{ type: "text", text: "Third world message" }],
                role: "assistant",
              },
            },
            createdAt: "2024-01-01T00:00:04Z",
          },
        ],
        hasMore: false,
        framework: "claude-code",
      };
    }

    function setupSearchHandlers() {
      server.use(
        http.get("*/api/platform/logs/:id", () => {
          return HttpResponse.json({
            id: "run-search-test",
            sessionId: "session-search",
            agentName: "Search Test Agent",
            framework: "claude-code",
            status: "completed",
            prompt: "Search test",
            error: null,
            createdAt: "2024-01-01T00:00:00Z",
            startedAt: "2024-01-01T00:00:01Z",
            completedAt: "2024-01-01T00:00:10Z",
            artifact: { name: null, version: null },
          });
        }),
        http.get("*/api/agent/runs/:id/telemetry/agent", () => {
          return HttpResponse.json(createSearchTestResponse());
        }),
      );
    }

    it("should display search input in the events card", async () => {
      setupSearchHandlers();

      await setupPage({
        context,
        path: "/logs/run-search-test",
      });

      await waitFor(() => {
        expect(screen.getByPlaceholderText("Search logs")).toBeInTheDocument();
      });
    });

    it("should filter events when searching", async () => {
      setupSearchHandlers();

      await setupPage({
        context,
        path: "/logs/run-search-test",
      });

      // Wait for events to load
      await waitFor(() => {
        expect(
          screen.getByText(/Hello world from assistant/),
        ).toBeInTheDocument();
      });

      // Type a search term that matches one message
      const searchInput = screen.getByPlaceholderText("Search logs");
      await user.type(searchInput, "Third");

      // Should show matching count in header (1 message matches out of 3)
      await waitFor(() => {
        expect(screen.getByText("(1/3 matched)")).toBeInTheDocument();
      });
    });

    it("should show match navigation when search has results", async () => {
      setupSearchHandlers();

      await setupPage({
        context,
        path: "/logs/run-search-test",
      });

      // Wait for events to load
      await waitFor(() => {
        expect(
          screen.getByText(/Hello world from assistant/),
        ).toBeInTheDocument();
      });

      // Type a search term that matches multiple times
      const searchInput = screen.getByPlaceholderText("Search logs");
      await user.type(searchInput, "world");

      // Should show match counter
      await waitFor(() => {
        // Match counter format is "X/Y" where X is current and Y is total
        expect(screen.getByText(/\/3$/)).toBeInTheDocument();
      });

      // Should show navigation buttons
      expect(
        screen.getByTitle("Previous match (Shift+Enter)"),
      ).toBeInTheDocument();
      expect(screen.getByTitle("Next match (Enter)")).toBeInTheDocument();
    });

    it("should navigate to next match with Enter key", async () => {
      setupSearchHandlers();

      await setupPage({
        context,
        path: "/logs/run-search-test",
      });

      // Wait for events to load
      await waitFor(() => {
        expect(
          screen.getByText(/Hello world from assistant/),
        ).toBeInTheDocument();
      });

      // Type a search term
      const searchInput = screen.getByPlaceholderText("Search logs");
      await user.type(searchInput, "world");

      // Wait for match counter to appear
      await waitFor(() => {
        expect(screen.getByText("1/3")).toBeInTheDocument();
      });

      // Press Enter to go to next match
      await user.type(searchInput, "{Enter}");

      // Should update to show match 2/3
      await waitFor(() => {
        expect(screen.getByText("2/3")).toBeInTheDocument();
      });
    });

    it("should navigate to previous match with Shift+Enter", async () => {
      setupSearchHandlers();

      await setupPage({
        context,
        path: "/logs/run-search-test",
      });

      // Wait for events to load
      await waitFor(() => {
        expect(
          screen.getByText(/Hello world from assistant/),
        ).toBeInTheDocument();
      });

      // Type a search term
      const searchInput = screen.getByPlaceholderText("Search logs");
      await user.type(searchInput, "world");

      // Wait for match counter to appear
      await waitFor(() => {
        expect(screen.getByText("1/3")).toBeInTheDocument();
      });

      // Press Shift+Enter to go to previous match (wraps to last)
      await user.type(searchInput, "{Shift>}{Enter}{/Shift}");

      // Should wrap to match 3/3
      await waitFor(() => {
        expect(screen.getByText("3/3")).toBeInTheDocument();
      });
    });

    it("should navigate with navigation buttons", async () => {
      setupSearchHandlers();

      await setupPage({
        context,
        path: "/logs/run-search-test",
      });

      // Wait for events to load
      await waitFor(() => {
        expect(
          screen.getByText(/Hello world from assistant/),
        ).toBeInTheDocument();
      });

      // Type a search term
      const searchInput = screen.getByPlaceholderText("Search logs");
      await user.type(searchInput, "world");

      // Wait for match counter to appear
      await waitFor(() => {
        expect(screen.getByText("1/3")).toBeInTheDocument();
      });

      // Click next button
      const nextButton = screen.getByTitle("Next match (Enter)");
      await user.click(nextButton);

      await waitFor(() => {
        expect(screen.getByText("2/3")).toBeInTheDocument();
      });

      // Click previous button
      const prevButton = screen.getByTitle("Previous match (Shift+Enter)");
      await user.click(prevButton);

      await waitFor(() => {
        expect(screen.getByText("1/3")).toBeInTheDocument();
      });
    });

    it("should reset match index when search term changes", async () => {
      setupSearchHandlers();

      await setupPage({
        context,
        path: "/logs/run-search-test",
      });

      // Wait for events to load
      await waitFor(() => {
        expect(
          screen.getByText(/Hello world from assistant/),
        ).toBeInTheDocument();
      });

      // Type a search term
      const searchInput = screen.getByPlaceholderText("Search logs");
      await user.type(searchInput, "world");

      // Wait and navigate to a different match
      await waitFor(() => {
        expect(screen.getByText("1/3")).toBeInTheDocument();
      });

      await user.type(searchInput, "{Enter}");
      await waitFor(() => {
        expect(screen.getByText("2/3")).toBeInTheDocument();
      });

      // Change search term - "message" appears in 2 assistant messages
      await user.clear(searchInput);
      await user.type(searchInput, "message");

      // Should reset to first match (2 matches for "message")
      await waitFor(() => {
        expect(screen.getByText("1/2")).toBeInTheDocument();
      });
    });

    it("should show 0/0 when search has no matches", async () => {
      setupSearchHandlers();

      await setupPage({
        context,
        path: "/logs/run-search-test",
      });

      // Wait for events to load
      await waitFor(() => {
        expect(
          screen.getByText(/Hello world from assistant/),
        ).toBeInTheDocument();
      });

      // Type a search term with no matches
      const searchInput = screen.getByPlaceholderText("Search logs");
      await user.type(searchInput, "nonexistent");

      // Should show 0/0
      await waitFor(() => {
        expect(screen.getByText("0/0")).toBeInTheDocument();
      });

      // Navigation buttons should be disabled
      const nextButton = screen.getByTitle("Next match (Enter)");
      const prevButton = screen.getByTitle("Previous match (Shift+Enter)");
      expect(nextButton).toBeDisabled();
      expect(prevButton).toBeDisabled();
    });

    it("should not show navigation when search is empty", async () => {
      setupSearchHandlers();

      await setupPage({
        context,
        path: "/logs/run-search-test",
      });

      // Wait for events to load
      await waitFor(() => {
        expect(
          screen.getByText(/Hello world from assistant/),
        ).toBeInTheDocument();
      });

      // Search navigation should not be visible
      expect(screen.queryByTitle("Next match (Enter)")).not.toBeInTheDocument();
      expect(
        screen.queryByTitle("Previous match (Shift+Enter)"),
      ).not.toBeInTheDocument();
    });
  });

  describe("collapsed tool groups", () => {
    function setupCollapsedToolHandlers() {
      server.use(
        http.get("*/api/platform/logs/:id", () => {
          return HttpResponse.json({
            id: "run-collapsed-tools",
            sessionId: null,
            agentName: "Tool Agent",
            framework: "claude-code",
            status: "completed",
            prompt: "Read some files",
            error: null,
            createdAt: "2024-01-01T00:00:00Z",
            startedAt: "2024-01-01T00:00:01Z",
            completedAt: "2024-01-01T00:00:10Z",
            artifact: { name: null, version: null },
          });
        }),
        http.get("*/api/agent/runs/:id/telemetry/agent", () => {
          return HttpResponse.json({
            events: [
              {
                sequenceNumber: 1,
                eventType: "assistant",
                eventData: {
                  message: {
                    content: [
                      { type: "text", text: "Let me read those files" },
                      {
                        type: "tool_use",
                        id: "read-1",
                        name: "Read",
                        input: { file_path: "/src/index.ts" },
                      },
                      {
                        type: "tool_use",
                        id: "read-2",
                        name: "Read",
                        input: { file_path: "/src/utils.ts" },
                      },
                      {
                        type: "tool_use",
                        id: "read-3",
                        name: "Read",
                        input: { file_path: "/src/config.ts" },
                      },
                    ],
                    role: "assistant",
                  },
                },
                createdAt: "2024-01-01T00:00:02Z",
              },
              {
                sequenceNumber: 2,
                eventType: "user",
                eventData: {
                  message: {
                    content: [
                      {
                        type: "tool_result",
                        tool_use_id: "read-1",
                        content: "file content 1",
                      },
                      {
                        type: "tool_result",
                        tool_use_id: "read-2",
                        content: "file content 2",
                      },
                      {
                        type: "tool_result",
                        tool_use_id: "read-3",
                        content: "file content 3",
                      },
                    ],
                    role: "user",
                  },
                },
                createdAt: "2024-01-01T00:00:03Z",
              },
              {
                sequenceNumber: 3,
                eventType: "assistant",
                eventData: {
                  message: {
                    content: [
                      {
                        type: "tool_use",
                        id: "bash-1",
                        name: "Bash",
                        input: { command: "npm test" },
                      },
                    ],
                    role: "assistant",
                  },
                },
                createdAt: "2024-01-01T00:00:04Z",
              },
              {
                sequenceNumber: 4,
                eventType: "user",
                eventData: {
                  message: {
                    content: [
                      {
                        type: "tool_result",
                        tool_use_id: "bash-1",
                        content: "all tests passed",
                      },
                    ],
                    role: "user",
                  },
                },
                createdAt: "2024-01-01T00:00:05Z",
              },
            ],
            hasMore: false,
            framework: "claude-code",
          });
        }),
      );
    }

    it("should collapse consecutive same-type tool calls with count badge", async () => {
      setupCollapsedToolHandlers();

      await setupPage({
        context,
        path: "/logs/run-collapsed-tools",
      });

      // Wait for assistant text to render
      await waitFor(() => {
        expect(screen.getByText(/Let me read those files/)).toBeInTheDocument();
      });

      // The 3 Read operations should be collapsed into a group with "3 files" badge
      await waitFor(() => {
        expect(screen.getByText("3 files")).toBeInTheDocument();
      });
    });

    it("should not collapse single tool calls", async () => {
      setupCollapsedToolHandlers();

      await setupPage({
        context,
        path: "/logs/run-collapsed-tools",
      });

      // Wait for collapsed group to render (proves events loaded)
      await waitFor(() => {
        expect(screen.getByText("3 files")).toBeInTheDocument();
      });

      // "1 calls" badge should NOT appear — single operations render individually
      expect(screen.queryByText("1 calls")).not.toBeInTheDocument();
      expect(screen.queryByText("1 call")).not.toBeInTheDocument();
    });
  });
});
