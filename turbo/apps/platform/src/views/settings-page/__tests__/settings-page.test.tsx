import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

describe("settings page", () => {
  it("should render settings page via direct URL", async () => {
    server.use(
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );

    await setupPage({ context, path: "/settings" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Settings", level: 1 }),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText("Configure model providers for your agents."),
    ).toBeInTheDocument();
  });

  it("should show provider cards when providers exist", async () => {
    server.use(
      http.get("*/api/zero/model-providers", () => {
        return HttpResponse.json({
          modelProviders: [
            {
              id: "prov-1",
              type: "anthropic-api-key",
              framework: "claude-code",
              secretName: "ANTHROPIC_API_KEY",
              authMethod: null,
              secretNames: null,
              isDefault: true,
              selectedModel: null,
              createdAt: "2026-03-01T00:00:00Z",
              updatedAt: "2026-03-01T00:00:00Z",
            },
          ],
        });
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );

    await setupPage({ context, path: "/settings" });

    await waitFor(() => {
      expect(screen.getByText("Configured")).toBeInTheDocument();
    });
  });

  it("should render sidebar on settings page", async () => {
    server.use(
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );

    await setupPage({ context, path: "/settings" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Settings", level: 1 }),
      ).toBeInTheDocument();
    });

    // Sidebar navigation should be present (multiple nav elements exist)
    const navElements = screen.getAllByRole("navigation");
    expect(navElements.length).toBeGreaterThanOrEqual(1);
  });
});
