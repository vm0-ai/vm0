import { describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server.ts";
import { http, HttpResponse } from "msw";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { screen } from "@testing-library/react";

const context = testContext();

describe("agents page", () => {
  it("shows agents table with agent names", async () => {
    server.use(
      http.get("/api/agent/composes/list", () => {
        return HttpResponse.json({
          composes: [
            {
              name: "my-agent",
              headVersionId: "v1",
              updatedAt: "2024-06-15T10:00:00Z",
            },
          ],
        });
      }),
    );

    await setupPage({ context, path: "/agents" });

    await vi.waitFor(() => {
      expect(screen.getByText("my-agent")).toBeInTheDocument();
    });
    // Table header "Your agents" should be present
    expect(screen.getByText("Model provider")).toBeInTheDocument();
    expect(screen.getByText("Schedule status")).toBeInTheDocument();
  });

  it("shows empty state when no agents exist", async () => {
    server.use(
      http.get("/api/agent/composes/list", () => {
        return HttpResponse.json({ composes: [] });
      }),
    );

    await setupPage({ context, path: "/agents" });

    await vi.waitFor(() => {
      expect(
        screen.getByText("No agents yet. Time to create your first one."),
      ).toBeInTheDocument();
    });
  });

  it("shows error state when agents API fails", async () => {
    server.use(
      http.get("/api/agent/composes/list", () => {
        return HttpResponse.json(
          { error: "Unauthorized" },
          { status: 401, statusText: "Unauthorized" },
        );
      }),
    );

    await setupPage({ context, path: "/agents" });

    await vi.waitFor(() => {
      expect(screen.getByText(/Whoops!/)).toBeInTheDocument();
    });
  });

  it("shows missing environment variables count for agent with missing items", async () => {
    server.use(
      http.get("/api/agent/composes/list", () => {
        return HttpResponse.json({
          composes: [
            {
              name: "my-agent",
              headVersionId: "v1",
              updatedAt: "2024-06-15T10:00:00Z",
            },
          ],
        });
      }),
      http.get("/api/agent/required-env", () => {
        return HttpResponse.json({
          agents: [
            {
              composeId: "c1",
              agentName: "my-agent",
              requiredSecrets: ["API_KEY", "OTHER_KEY"],
              requiredVariables: ["MY_VAR"],
            },
          ],
        });
      }),
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
      http.get("/api/connectors", () => {
        return HttpResponse.json({ connectors: [], configuredTypes: [] });
      }),
    );

    await setupPage({ context, path: "/agents" });

    await vi.waitFor(() => {
      expect(screen.getByText("my-agent")).toBeInTheDocument();
    });

    // Should display "Missing 3 environment variables" (2 secrets + 1 variable)
    await vi.waitFor(() => {
      expect(
        screen.getByText("Missing 3 environment variables"),
      ).toBeInTheDocument();
    });
  });

  it("shows singular label for one missing environment variable", async () => {
    server.use(
      http.get("/api/agent/composes/list", () => {
        return HttpResponse.json({
          composes: [
            {
              name: "my-agent",
              headVersionId: "v1",
              updatedAt: "2024-06-15T10:00:00Z",
            },
          ],
        });
      }),
      http.get("/api/agent/required-env", () => {
        return HttpResponse.json({
          agents: [
            {
              composeId: "c1",
              agentName: "my-agent",
              requiredSecrets: ["API_KEY"],
              requiredVariables: [],
            },
          ],
        });
      }),
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
      http.get("/api/connectors", () => {
        return HttpResponse.json({ connectors: [], configuredTypes: [] });
      }),
    );

    await setupPage({ context, path: "/agents" });

    await vi.waitFor(() => {
      expect(
        screen.getByText("Missing 1 environment variable"),
      ).toBeInTheDocument();
    });
  });

  it("does not show missing env count when all items are provided", async () => {
    server.use(
      http.get("/api/agent/composes/list", () => {
        return HttpResponse.json({
          composes: [
            {
              name: "my-agent",
              headVersionId: "v1",
              updatedAt: "2024-06-15T10:00:00Z",
            },
          ],
        });
      }),
      http.get("/api/agent/required-env", () => {
        return HttpResponse.json({
          agents: [
            {
              composeId: "c1",
              agentName: "my-agent",
              requiredSecrets: ["API_KEY"],
              requiredVariables: ["MY_VAR"],
            },
          ],
        });
      }),
      http.get("/api/secrets", () => {
        return HttpResponse.json({
          secrets: [
            {
              id: "s1",
              name: "API_KEY",
              type: "user",
              description: null,
              createdAt: "2024-01-01",
              updatedAt: "2024-01-01",
            },
          ],
        });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({
          variables: [
            {
              id: "v1",
              name: "MY_VAR",
              value: "val",
              description: null,
              createdAt: "2024-01-01",
              updatedAt: "2024-01-01",
            },
          ],
        });
      }),
      http.get("/api/connectors", () => {
        return HttpResponse.json({ connectors: [], configuredTypes: [] });
      }),
    );

    await setupPage({ context, path: "/agents" });

    await vi.waitFor(() => {
      expect(screen.getByText("my-agent")).toBeInTheDocument();
    });

    // Give time for async missing items to resolve, then verify no warning
    // Wait a tick for any pending updates
    await vi.waitFor(() => {
      expect(
        screen.queryByText(/Missing \d+ environment variable/),
      ).not.toBeInTheDocument();
    });
  });
});
