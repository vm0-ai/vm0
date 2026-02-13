import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { describe, expect, it, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { http, HttpResponse } from "msw";
import { FeatureSwitchKey } from "@vm0/core";

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

    await vi.waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Run this agent" }),
      ).not.toBeInTheDocument();
    });

    // Verify API was called with correct body
    expect(capturedBody).toStrictEqual({
      agentComposeId: "compose_1",
      prompt: "Fix the bug",
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

    await vi.waitFor(() => {
      expect(screen.getByText("Rate limit exceeded")).toBeInTheDocument();
    });
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
