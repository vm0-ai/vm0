import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { describe, expect, it, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { http, HttpResponse } from "msw";
const context = testContext();

function makeSchedule(overrides?: Record<string, unknown>) {
  return {
    id: "schedule_1",
    composeId: "compose_1",
    composeName: "my-agent",
    scopeSlug: "test-user",
    name: "default",
    cronExpression: "30 14 * * 1-5",
    atTime: null,
    timezone: "UTC",
    prompt: "Daily standup summary",
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
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function mockAgentDetailAPI(
  opts: { withSchedule?: boolean } = { withSchedule: true },
) {
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
    http.get("/api/agent/schedules", () => {
      return HttpResponse.json({
        schedules: opts.withSchedule ? [makeSchedule()] : [],
      });
    }),
    http.post("/api/agent/schedules/:name/enable", () => {
      return new HttpResponse(null, { status: 200 });
    }),
  );
}

describe("schedule dialog", () => {
  it("should show Scheduled badge when agent has active schedule", async () => {
    mockAgentDetailAPI({ withSchedule: true });

    await setupPage({
      context,
      path: "/agents/my-agent",
    });

    await vi.waitFor(() => {
      expect(screen.getByText("Scheduled")).toBeInTheDocument();
    });
  });

  it("should not show Scheduled badge when no schedule exists", async () => {
    mockAgentDetailAPI({ withSchedule: false });

    await setupPage({
      context,
      path: "/agents/my-agent",
    });

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "my-agent" }),
      ).toBeInTheDocument();
    });

    expect(screen.queryByText("Scheduled")).not.toBeInTheDocument();
  });

  it("should open edit dialog when clicking schedule badge edit button", async () => {
    mockAgentDetailAPI({ withSchedule: true });

    await setupPage({
      context,
      path: "/agents/my-agent",
    });

    await vi.waitFor(() => {
      expect(screen.getByText("Scheduled")).toBeInTheDocument();
    });

    // Click the edit button next to the Scheduled badge
    fireEvent.click(screen.getByRole("button", { name: "Edit schedule" }));

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Edit this schedule" }),
      ).toBeInTheDocument();
    });

    // Prompt should be pre-filled
    const textarea = screen.getByDisplayValue("Daily standup summary");
    expect(textarea).toBeInTheDocument();
  });

  it("should update schedule on save", async () => {
    mockAgentDetailAPI({ withSchedule: true });

    let capturedBody: unknown = null;
    server.use(
      http.post("/api/agent/schedules", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(makeSchedule(), { status: 201 });
      }),
    );

    await setupPage({
      context,
      path: "/agents/my-agent",
    });

    await vi.waitFor(() => {
      expect(screen.getByText("Scheduled")).toBeInTheDocument();
    });

    // Open schedule dialog
    fireEvent.click(screen.getByRole("button", { name: "Edit schedule" }));

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Edit this schedule" }),
      ).toBeInTheDocument();
    });

    // Modify prompt
    const textarea = screen.getByDisplayValue("Daily standup summary");
    fireEvent.change(textarea, {
      target: { value: "Updated standup summary" },
    });

    // Click save
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await vi.waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Edit this schedule" }),
      ).not.toBeInTheDocument();
    });

    const body = capturedBody as Record<string, unknown>;
    expect(body.composeId).toBe("compose_1");
    expect(body.prompt).toBe("Updated standup summary");
  });

  it("should delete schedule and hide badge", async () => {
    mockAgentDetailAPI({ withSchedule: true });

    server.use(
      http.delete("/api/agent/schedules/:name", () => {
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await setupPage({
      context,
      path: "/agents/my-agent",
    });

    await vi.waitFor(() => {
      expect(screen.getByText("Scheduled")).toBeInTheDocument();
    });

    // Open schedule dialog
    fireEvent.click(screen.getByRole("button", { name: "Edit schedule" }));

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Edit this schedule" }),
      ).toBeInTheDocument();
    });

    // Click delete button
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    // Dialog should close and badge should disappear
    await vi.waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Edit this schedule" }),
      ).not.toBeInTheDocument();
    });

    await vi.waitFor(() => {
      expect(screen.queryByText("Scheduled")).not.toBeInTheDocument();
    });
  });
});
