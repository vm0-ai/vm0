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
    triggerType: "cron",
    cronExpression: "30 14 * * 1-5",
    atTime: null,
    intervalSeconds: null,
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
    consecutiveFailures: 0,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function mockAgentDetailAPI(
  opts: {
    withSchedule?: boolean;
    schedule?: Record<string, unknown>;
  } = { withSchedule: true },
) {
  const scheduleData = opts.schedule
    ? makeSchedule(opts.schedule)
    : makeSchedule();

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
        schedules: opts.withSchedule ? [scheduleData] : [],
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
    expect(body.timezone).toBeDefined();
  });

  it("should restore saved timezone in edit dialog", async () => {
    mockAgentDetailAPI({
      withSchedule: true,
      schedule: { timezone: "Asia/Tokyo" },
    });

    await setupPage({
      context,
      path: "/agents/my-agent",
    });

    await vi.waitFor(() => {
      expect(screen.getByText("Scheduled")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit schedule" }));

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Edit this schedule" }),
      ).toBeInTheDocument();
    });

    // The timezone select should show the saved timezone
    expect(screen.getByText("Asia/Tokyo")).toBeInTheDocument();
  });

  it("should show Scheduled badge for one-time schedule", async () => {
    mockAgentDetailAPI({
      withSchedule: true,
      schedule: {
        cronExpression: null,
        atTime: "2030-06-15T14:30:00.000Z",
        prompt: "One-time report",
        nextRunAt: "2030-06-15T14:30:00.000Z",
      },
    });

    await setupPage({
      context,
      path: "/agents/my-agent",
    });

    await vi.waitFor(() => {
      expect(screen.getByText("Scheduled")).toBeInTheDocument();
    });
  });

  it("should open edit dialog with one-time fields for atTime schedule", async () => {
    mockAgentDetailAPI({
      withSchedule: true,
      schedule: {
        cronExpression: null,
        atTime: "2030-06-15T14:30:00.000Z",
        prompt: "One-time report",
      },
    });

    await setupPage({
      context,
      path: "/agents/my-agent",
    });

    await vi.waitFor(() => {
      expect(screen.getByText("Scheduled")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit schedule" }));

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Edit this schedule" }),
      ).toBeInTheDocument();
    });

    // Prompt should be pre-filled
    expect(screen.getByDisplayValue("One-time report")).toBeInTheDocument();
  });

  it("should update one-time schedule on save", async () => {
    mockAgentDetailAPI({
      withSchedule: true,
      schedule: {
        cronExpression: null,
        atTime: "2030-06-15T14:30:00.000Z",
        prompt: "One-time report",
      },
    });

    let capturedBody: unknown = null;
    server.use(
      http.post("/api/agent/schedules", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(
          makeSchedule({
            cronExpression: null,
            atTime: "2030-06-15T14:30:00.000Z",
            prompt: "Updated one-time report",
          }),
          { status: 200 },
        );
      }),
    );

    await setupPage({
      context,
      path: "/agents/my-agent",
    });

    await vi.waitFor(() => {
      expect(screen.getByText("Scheduled")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit schedule" }));

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Edit this schedule" }),
      ).toBeInTheDocument();
    });

    // Modify prompt
    const textarea = screen.getByDisplayValue("One-time report");
    fireEvent.change(textarea, {
      target: { value: "Updated one-time report" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await vi.waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Edit this schedule" }),
      ).not.toBeInTheDocument();
    });

    // Verify API was called with atTime (not cronExpression)
    const body = capturedBody as Record<string, unknown>;
    expect(body.composeId).toBe("compose_1");
    expect(body.atTime).toBeDefined();
    expect(body.cronExpression).toBeUndefined();
    expect(body.prompt).toBe("Updated one-time report");
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

  it("should show Scheduled badge for loop schedule", async () => {
    mockAgentDetailAPI({
      withSchedule: true,
      schedule: {
        triggerType: "loop",
        cronExpression: null,
        intervalSeconds: 300,
        prompt: "Continuous monitoring",
      },
    });

    await setupPage({ context, path: "/agents/my-agent" });

    await vi.waitFor(() => {
      expect(screen.getByText("Scheduled")).toBeInTheDocument();
    });
  });

  it("should open edit dialog with loop fields for loop schedule", async () => {
    mockAgentDetailAPI({
      withSchedule: true,
      schedule: {
        triggerType: "loop",
        cronExpression: null,
        intervalSeconds: 300,
        prompt: "Continuous monitoring",
      },
    });

    await setupPage({ context, path: "/agents/my-agent" });

    await vi.waitFor(() => {
      expect(screen.getByText("Scheduled")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit schedule" }));

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Edit this schedule" }),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByDisplayValue("Continuous monitoring"),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("300")).toBeInTheDocument();
  });

  it("should save loop schedule with intervalSeconds", async () => {
    mockAgentDetailAPI({
      withSchedule: true,
      schedule: {
        triggerType: "loop",
        cronExpression: null,
        intervalSeconds: 300,
        prompt: "Continuous monitoring",
      },
    });

    let capturedBody: unknown = null;
    server.use(
      http.post("/api/agent/schedules", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(
          makeSchedule({
            triggerType: "loop",
            cronExpression: null,
            intervalSeconds: 300,
            prompt: "Updated monitoring",
          }),
          { status: 200 },
        );
      }),
    );

    await setupPage({ context, path: "/agents/my-agent" });

    await vi.waitFor(() => {
      expect(screen.getByText("Scheduled")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit schedule" }));

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Edit this schedule" }),
      ).toBeInTheDocument();
    });

    const textarea = screen.getByDisplayValue("Continuous monitoring");
    fireEvent.change(textarea, { target: { value: "Updated monitoring" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await vi.waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Edit this schedule" }),
      ).not.toBeInTheDocument();
    });

    const body = capturedBody as Record<string, unknown>;
    expect(body.composeId).toBe("compose_1");
    expect(body.intervalSeconds).toBe(300);
    expect(body.cronExpression).toBeUndefined();
    expect(body.atTime).toBeUndefined();
    expect(body.prompt).toBe("Updated monitoring");
  });
});
