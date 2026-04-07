/**
 * Tests for the /connectors/:type/connect page (ZeroDirectedConnectPage).
 *
 * Entry point: setupPage({ path: "/connectors/:type/connect" })
 * Mock (external): connectors API via MSW
 * Real (internal): signals, components, rendering
 */

import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { CONNECTOR_TYPES, type ConnectorType } from "@vm0/core";

const context = testContext();

function mockConnectors(
  connectors: { type: ConnectorType; externalUsername?: string }[],
) {
  server.use(
    http.get("*/api/zero/connectors", () => {
      return HttpResponse.json({
        connectors: connectors.map((c) => {
          return {
            id: crypto.randomUUID(),
            type: c.type,
            authMethod: "oauth",
            externalId: null,
            externalUsername: c.externalUsername ?? null,
            externalEmail: null,
            oauthScopes: null,
            needsReconnect: false,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          };
        }),
        configuredTypes: Object.keys(CONNECTOR_TYPES),
        connectorProvidedSecretNames: [],
      });
    }),
  );
}

describe("directed connect page", () => {
  it("renders connect card for an oauth connector", async () => {
    await setupPage({ context, path: "/connectors/gmail/connect" });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Gmail to proceed"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText(CONNECTOR_TYPES.gmail.helpText),
    ).toBeInTheDocument();
    expect(screen.getByText("Connect")).toBeInTheDocument();
  });

  it("shows connected state when connector is already connected", async () => {
    mockConnectors([{ type: "github" }]);

    await setupPage({ context, path: "/connectors/github/connect" });

    await waitFor(() => {
      expect(screen.getByText("GitHub connected")).toBeInTheDocument();
    });
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByText("Connect")).not.toBeInTheDocument();
  });

  it("normalizes uppercase type in URL to match connector key", async () => {
    await setupPage({ context, path: "/connectors/Gmail/connect" });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Gmail to proceed"),
      ).toBeInTheDocument();
    });
  });

  it("renders nothing for an unknown connector type", async () => {
    await setupPage({ context, path: "/connectors/nonexistent/connect" });

    // The card should not render — no heading, no button
    await waitFor(() => {
      expect(
        screen.queryByText(/Zero needs .* to proceed/),
      ).not.toBeInTheDocument();
    });
    expect(screen.queryByText("Connect")).not.toBeInTheDocument();
  });

  it("opens api-token dialog for a connector without oauth", async () => {
    const user = userEvent.setup();

    // Find a connector type that only has api-token auth
    const apiTokenOnlyType = (
      Object.keys(CONNECTOR_TYPES) as ConnectorType[]
    ).find((type) => {
      const methods = CONNECTOR_TYPES[type].authMethods;
      return "api-token" in methods && !("oauth" in methods);
    });

    // Skip if no api-token-only connector exists
    if (!apiTokenOnlyType) {
      return;
    }

    const config = CONNECTOR_TYPES[apiTokenOnlyType];

    await setupPage({
      context,
      path: `/connectors/${apiTokenOnlyType}/connect`,
    });

    await waitFor(() => {
      expect(
        screen.getByText(`Zero needs ${config.label} to proceed`),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByText("Connect"));

    // Dialog should open with the connector label as title
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: config.label }),
      ).toBeInTheDocument();
    });
  });

  it("has a logo link that navigates to /connectors", async () => {
    await setupPage({ context, path: "/connectors/gmail/connect" });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Gmail to proceed"),
      ).toBeInTheDocument();
    });

    const logoLink = screen.getByLabelText("VM0");
    expect(logoLink.closest("a")).toHaveAttribute("href", "/connectors");
  });

  it("shows error toast when api token submission fails (CONN-D-045)", async () => {
    const user = userEvent.setup();

    server.use(
      http.post("*/api/zero/secrets", () => {
        return HttpResponse.json(
          { error: { message: "Invalid API token", code: "UNAUTHORIZED" } },
          { status: 401 },
        );
      }),
    );

    await setupPage({ context, path: "/connectors/axiom/connect" });

    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((el) => {
          return el.textContent?.trim() === "Connect";
        }),
      ).toBeDefined();
    });

    const connectBtn1 = screen.getAllByRole("button").find((el) => {
      return el.textContent?.trim() === "Connect";
    });
    expect(connectBtn1).toBeDefined();
    await user.click(connectBtn1!);

    await waitFor(() => {
      expect(screen.getByPlaceholderText("xaat-...")).toBeInTheDocument();
    });

    await user.type(screen.getByPlaceholderText("xaat-..."), "bad-token");
    const saveBtn1 = screen.getAllByRole("button").find((el) => {
      return el.textContent?.trim() === "Save";
    });
    expect(saveBtn1).toBeDefined();
    await user.click(saveBtn1!);

    await waitFor(() => {
      expect(screen.getByText("Invalid API token")).toBeInTheDocument();
    });
  });

  it("connect button opens OAuth flow for OAuth-enabled connector (CONN-I-047)", async () => {
    const user = userEvent.setup();
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValue({ closed: true } as Window);

    await setupPage({ context, path: "/connectors/gmail/connect" });

    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((el) => {
          return el.textContent?.trim() === "Connect";
        }),
      ).toBeDefined();
    });

    const connectBtn2 = screen.getAllByRole("button").find((el) => {
      return el.textContent?.trim() === "Connect";
    });
    expect(connectBtn2).toBeDefined();
    await user.click(connectBtn2!);

    expect(openSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/zero/connectors/gmail/authorize"),
      "_blank",
      expect.any(String),
    );
  });

  it("save button submits the api token to the server (CONN-I-049)", async () => {
    const user = userEvent.setup();
    let capturedBody: { name: string; value: string } | undefined;

    server.use(
      http.post("*/api/zero/secrets", async ({ request }) => {
        capturedBody = (await request.json()) as {
          name: string;
          value: string;
        };
        return HttpResponse.json(
          {
            id: crypto.randomUUID(),
            name: capturedBody.name,
            type: "user",
            description: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          { status: 201 },
        );
      }),
    );

    await setupPage({ context, path: "/connectors/axiom/connect" });

    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((el) => {
          return el.textContent?.trim() === "Connect";
        }),
      ).toBeDefined();
    });

    const connectBtn3 = screen.getAllByRole("button").find((el) => {
      return el.textContent?.trim() === "Connect";
    });
    expect(connectBtn3).toBeDefined();
    await user.click(connectBtn3!);

    await waitFor(() => {
      expect(screen.getByPlaceholderText("xaat-...")).toBeInTheDocument();
    });

    await user.type(
      screen.getByPlaceholderText("xaat-..."),
      "test-token-value",
    );
    const saveBtn2 = screen.getAllByRole("button").find((el) => {
      return el.textContent?.trim() === "Save";
    });
    expect(saveBtn2).toBeDefined();
    await user.click(saveBtn2!);

    await waitFor(() => {
      expect(capturedBody).toBeDefined();
      expect(capturedBody?.name).toBe("AXIOM_TOKEN");
      expect(capturedBody?.value).toBe("test-token-value");
    });
  });
});
