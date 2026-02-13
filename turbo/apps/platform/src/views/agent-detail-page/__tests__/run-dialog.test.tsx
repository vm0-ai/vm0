import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { describe, expect, it, vi } from "vitest";
import { screen, fireEvent, act } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { http, HttpResponse } from "msw";
import { FeatureSwitchKey } from "@vm0/core";
import {
  setRunDialogTimeOption$,
  setRunDialogFrequency$,
} from "../../../signals/agent-detail/run-dialog.ts";

const context = testContext();

function mockAgentDetailAPI() {
  server.use(
    http.get("/api/agent/composes", ({ request }) => {
      const url = new URL(request.url);
      const name = url.searchParams.get("name");

      if (name !== "my-agent") {
        return new HttpResponse(null, { status: 404 });
      }

      return HttpResponse.json({
        id: "compose_1",
        name: "my-agent",
        headVersionId: "version_1",
        content: {
          version: "1",
          agents: {
            "my-agent": {
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
      return HttpResponse.json({
        content: "# Instructions",
        filename: "instructions.md",
      });
    }),
    // Mock inline run polling endpoints (needed when "now" runs trigger polling)
    http.get("/api/agent/runs/:runId/telemetry/agent", () => {
      return HttpResponse.json({ events: [], hasMore: false });
    }),
    http.get("/api/platform/logs/:runId", () => {
      return HttpResponse.json({
        id: "run_1",
        status: "completed",
        createdAt: "2024-01-01T00:00:00Z",
      });
    }),
  );
}

describe("run dialog", () => {
  it("should open run dialog with prompt textarea", async () => {
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

    // Click Run button
    const runButton = screen.getByRole("button", { name: /Run/ });
    fireEvent.click(runButton);

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Run this agent" }),
      ).toBeInTheDocument();
    });

    // Should show prompt textarea
    expect(
      screen.getByPlaceholderText("Describe your task in natural language."),
    ).toBeInTheDocument();
  });

  it("should disable Save when prompt is empty", async () => {
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

    fireEvent.click(screen.getByRole("button", { name: /Run/ }));

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Run this agent" }),
      ).toBeInTheDocument();
    });

    // Save should be disabled when prompt is empty
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("should create immediate run when Time is Now", async () => {
    mockAgentDetailAPI();

    let capturedBody: unknown = null;
    server.use(
      http.post("/api/agent/runs", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(
          {
            runId: "run_1",
            status: "pending",
            createdAt: "2024-01-01T00:00:00Z",
          },
          { status: 201 },
        );
      }),
    );

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

    fireEvent.click(screen.getByRole("button", { name: /Run/ }));

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Run this agent" }),
      ).toBeInTheDocument();
    });

    // Type a prompt
    const textarea = screen.getByPlaceholderText(
      "Describe your task in natural language.",
    );
    fireEvent.change(textarea, { target: { value: "Fix the bug" } });

    // Click Save (Time defaults to "Now")
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // Dialog closes immediately for "now" runs; API continues in background
    await vi.waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Run this agent" }),
      ).not.toBeInTheDocument();
    });

    // Verify API was called with correct body (async, so wait for it)
    await vi.waitFor(() => {
      expect(capturedBody).toStrictEqual({
        agentComposeId: "compose_1",
        prompt: "Fix the bug",
      });
    });
  });

  it("should show error when run fails", async () => {
    mockAgentDetailAPI();

    server.use(
      http.post("/api/agent/runs", () => {
        return HttpResponse.json(
          { message: "Rate limit exceeded" },
          { status: 429 },
        );
      }),
    );

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

    fireEvent.click(screen.getByRole("button", { name: /Run/ }));

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Run this agent" }),
      ).toBeInTheDocument();
    });

    const textarea = screen.getByPlaceholderText(
      "Describe your task in natural language.",
    );
    fireEvent.change(textarea, { target: { value: "Do something" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // For "now" runs, errors appear as toasts (dialog closes immediately)
    await vi.waitFor(() => {
      expect(screen.getByText("Rate limit exceeded")).toBeInTheDocument();
    });
  });

  it("should create schedule when time is not Now", async () => {
    mockAgentDetailAPI();

    let capturedBody: unknown = null;
    server.use(
      http.post("/api/agent/schedules", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(
          {
            id: "schedule_1",
            composeId: "compose_1",
            composeName: "my-agent",
            scopeSlug: "test-user",
            name: "default",
            cronExpression: "0 9 * * 1-5",
            atTime: null,
            timezone: "UTC",
            prompt: "Daily review",
            vars: null,
            secretNames: null,
            artifactName: null,
            artifactVersion: null,
            volumeVersions: null,
            enabled: true,
            nextRunAt: null,
            lastRunAt: null,
            retryStartedAt: null,
            createdAt: "2024-01-01T00:00:00Z",
          },
          { status: 201 },
        );
      }),
    );

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

    fireEvent.click(screen.getByRole("button", { name: /Run/ }));

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Run this agent" }),
      ).toBeInTheDocument();
    });

    // Type a prompt
    const textarea = screen.getByPlaceholderText(
      "Describe your task in natural language.",
    );
    fireEvent.change(textarea, { target: { value: "Daily review" } });

    // Set time option to schedule via signal (Radix Select is hard to drive in tests)
    act(() => {
      context.store.set(setRunDialogTimeOption$, "every-weekday");
      context.store.set(setRunDialogFrequency$, "9");
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await vi.waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Run this agent" }),
      ).not.toBeInTheDocument();
    });

    // Verify schedule API was called with cron expression
    const body = capturedBody as Record<string, unknown>;
    expect(body.composeId).toBe("compose_1");
    expect(body.cronExpression).toBe("0 9 * * 1-5");
    expect(body.prompt).toBe("Daily review");
    expect(body.name).toBe("default");
  });

  it("should close dialog on Cancel", async () => {
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

    fireEvent.click(screen.getByRole("button", { name: /Run/ }));

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Run this agent" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await vi.waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Run this agent" }),
      ).not.toBeInTheDocument();
    });
  });
});
