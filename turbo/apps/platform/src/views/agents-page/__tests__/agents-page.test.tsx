import { describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server.ts";
import { http, HttpResponse } from "msw";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";

const context = testContext();
const user = userEvent.setup();

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
        return HttpResponse.json({ connectors: [] });
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
        return HttpResponse.json({ connectors: [] });
      }),
    );

    await setupPage({ context, path: "/agents" });

    await vi.waitFor(() => {
      expect(
        screen.getByText("Missing 1 environment variable"),
      ).toBeInTheDocument();
    });
  });

  it("shows missing env banner in agent dialog with secrets/variables link", async () => {
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
              requiredSecrets: ["CUSTOM_KEY"],
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
        return HttpResponse.json({ connectors: [] });
      }),
    );

    await setupPage({ context, path: "/agents" });

    // Wait for the missing items to load
    await vi.waitFor(() => {
      expect(
        screen.getByText(/Missing \d+ environment variable/),
      ).toBeInTheDocument();
    });

    // Click on the agent row to open the dialog
    await user.click(screen.getByText("my-agent"));

    // Dialog should open
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Manage my-agent")).toBeInTheDocument();

    // Should show the missing env banner
    expect(within(dialog).getByText(/missing some/)).toBeInTheDocument();

    // Should show a link to secrets or variables
    expect(
      within(dialog).getByRole("button", {
        name: /secrets or variables/i,
      }),
    ).toBeInTheDocument();
  });

  it("shows connectors link in banner when missing connector-resolvable secrets", async () => {
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
              // GH_TOKEN is resolvable by the GitHub connector
              requiredSecrets: ["GH_TOKEN"],
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
        return HttpResponse.json({ connectors: [] });
      }),
    );

    await setupPage({ context, path: "/agents" });

    // Wait for missing items to compute
    await vi.waitFor(() => {
      expect(
        screen.getByText(/Missing \d+ environment variable/),
      ).toBeInTheDocument();
    });

    // Open the agent dialog
    await user.click(screen.getByText("my-agent"));

    const dialog = await screen.findByRole("dialog");

    // Should show the connectors link
    expect(
      within(dialog).getByRole("button", { name: /connectors/i }),
    ).toBeInTheDocument();
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
        return HttpResponse.json({ connectors: [] });
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
