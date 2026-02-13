import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { describe, expect, it, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { http, HttpResponse } from "msw";
import { FeatureSwitchKey } from "@vm0/core";

const context = testContext();

function mockAgentDetailAPI(options?: {
  name?: string;
  description?: string;
  framework?: string;
  skills?: string[];
  instructions?: { content: string | null; filename: string | null };
}) {
  const name = options?.name ?? "my-agent";
  const description = options?.description ?? "A test agent";
  const framework = options?.framework ?? "claude-code";
  const skills = options?.skills ?? [];
  const instructions = options?.instructions ?? {
    content: "# Instructions",
    filename: "instructions.md",
  };

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
              description,
              framework,
              skills,
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

/** Find the header settings icon button (has aria-label="Settings") */
function findSettingsIconButton(): HTMLElement {
  const buttons = screen.getAllByRole("button", { name: "Settings" });
  const iconButton = buttons.find((btn) => btn.hasAttribute("aria-label"));
  if (!iconButton) {
    throw new Error("Settings icon button not found");
  }
  return iconButton;
}

describe("config dialog", () => {
  it("should open config dialog and show YAML tab by default", async () => {
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

    fireEvent.click(findSettingsIconButton());

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Your agent configs" }),
      ).toBeInTheDocument();
    });

    // YAML tab should be active by default
    expect(screen.getByRole("tab", { name: "vm0.yaml" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("should switch between YAML and Forms tabs", async () => {
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

    fireEvent.click(findSettingsIconButton());

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Your agent configs" }),
      ).toBeInTheDocument();
    });

    // Switch to Forms tab
    fireEvent.click(screen.getByRole("tab", { name: "Forms" }));

    // Should show form fields
    await vi.waitFor(() => {
      expect(screen.getByDisplayValue("my-agent")).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue("A test agent")).toBeInTheDocument();
  });

  it("should show skills as tags in Forms tab", async () => {
    mockAgentDetailAPI({
      skills: [
        "https://github.com/vm0-ai/vm0-skills/tree/main/hackernews",
        "https://github.com/vm0-ai/vm0-skills/tree/main/github",
      ],
    });

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

    fireEvent.click(findSettingsIconButton());

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Your agent configs" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("tab", { name: "Forms" }));

    await vi.waitFor(() => {
      expect(screen.getByText("hackernews")).toBeInTheDocument();
    });
    expect(screen.getByText("github")).toBeInTheDocument();
  });

  it("should sync Forms edits back to YAML tab", async () => {
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

    fireEvent.click(findSettingsIconButton());

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Your agent configs" }),
      ).toBeInTheDocument();
    });

    // Switch to Forms tab and change description
    fireEvent.click(screen.getByRole("tab", { name: "Forms" }));

    await vi.waitFor(() => {
      expect(screen.getByDisplayValue("A test agent")).toBeInTheDocument();
    });

    const descInput = screen.getByDisplayValue("A test agent");
    fireEvent.change(descInput, { target: { value: "Updated description" } });

    // Switch to YAML tab and verify the change is reflected
    fireEvent.click(screen.getByRole("tab", { name: "vm0.yaml" }));

    await vi.waitFor(() => {
      const textarea = document.querySelector("textarea");
      expect(textarea?.value).toContain("Updated description");
    });
  });

  it("should save config and close dialog on success", async () => {
    mockAgentDetailAPI();

    let capturedBody: unknown = null;
    server.use(
      http.post("/api/agent/composes", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(
          {
            composeId: "compose_1",
            name: "my-agent",
            versionId: "version_2",
            action: "existing",
            updatedAt: "2024-01-02T00:00:00Z",
          },
          { status: 200 },
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

    fireEvent.click(findSettingsIconButton());

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Your agent configs" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await vi.waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Your agent configs" }),
      ).not.toBeInTheDocument();
    });

    expect(capturedBody).toHaveProperty("content");
  });

  it("should show error when save fails", async () => {
    mockAgentDetailAPI();

    server.use(
      http.post("/api/agent/composes", () => {
        return HttpResponse.json(
          { message: "Validation failed" },
          { status: 400 },
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

    fireEvent.click(findSettingsIconButton());

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Your agent configs" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await vi.waitFor(() => {
      expect(screen.getByText("Validation failed")).toBeInTheDocument();
    });
  });

  it("should close dialog without saving on Cancel", async () => {
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

    fireEvent.click(findSettingsIconButton());

    await vi.waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Your agent configs" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await vi.waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Your agent configs" }),
      ).not.toBeInTheDocument();
    });
  });
});
