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
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { CONNECTOR_TYPES, type ConnectorType } from "@vm0/core";
import { setMockConnectors } from "../../../mocks/handlers/api-connectors.ts";

const context = testContext();

function mockConnectors(
  connectors: { type: ConnectorType; externalUsername?: string }[],
) {
  setMockConnectors(
    connectors.map((c) => {
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
  );
}

const AGENT_ID = "00000000-0000-0000-0000-000000000001";

function mockAgentWithName(agentId: string, displayName: string) {
  server.use(
    http.get("*/api/zero/team", () => {
      return HttpResponse.json([
        {
          id: agentId,
          displayName,
          description: null,
          sound: null,
          avatarUrl: null,
          headVersionId: "version_1",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ]);
    }),
  );
}

function mockUserConnectors(agentId: string, enabledTypes: string[] = []) {
  server.use(
    http.get(`*/api/zero/agents/${agentId}/user-connectors`, () => {
      return HttpResponse.json({ enabledTypes });
    }),
    http.put(`*/api/zero/agents/${agentId}/user-connectors`, () => {
      return HttpResponse.json({ enabledTypes });
    }),
  );
}

describe("directed connect page", () => {
  it("renders connect card for an oauth connector", async () => {
    detachedSetupPage({ context, path: "/connectors/gmail/connect" });

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

    detachedSetupPage({ context, path: "/connectors/github/connect" });

    await waitFor(() => {
      expect(screen.getByText("GitHub connected")).toBeInTheDocument();
    });
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByText("Connect")).not.toBeInTheDocument();
  });

  it("normalizes uppercase type in URL to match connector key", async () => {
    detachedSetupPage({ context, path: "/connectors/Gmail/connect" });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Gmail to proceed"),
      ).toBeInTheDocument();
    });
  });

  it("renders nothing for an unknown connector type", async () => {
    detachedSetupPage({ context, path: "/connectors/nonexistent/connect" });

    // The card should not render — no heading, no button
    await waitFor(() => {
      expect(
        screen.queryByText(/Zero needs .* to proceed/),
      ).not.toBeInTheDocument();
    });
    expect(screen.queryByText("Connect")).not.toBeInTheDocument();
  });

  it("shows agent display name instead of 'Zero' when agent has a name", async () => {
    mockAgentWithName(AGENT_ID, "My Assistant");

    detachedSetupPage({
      context,
      path: `/connectors/gmail/connect?agentId=${AGENT_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByText("My Assistant needs Gmail to proceed"),
      ).toBeInTheDocument();
    });
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

    detachedSetupPage({
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
    detachedSetupPage({ context, path: "/connectors/gmail/connect" });

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

    detachedSetupPage({ context, path: "/connectors/axiom/connect" });

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

    detachedSetupPage({ context, path: "/connectors/gmail/connect" });

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

    detachedSetupPage({ context, path: "/connectors/axiom/connect" });

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

  it("auto-authorizes agent after API token connect when agentId is present", async () => {
    const user = userEvent.setup();
    mockUserConnectors(AGENT_ID);

    let authorizeCalled = false;
    server.use(
      http.post("*/api/zero/secrets", () => {
        return HttpResponse.json(
          {
            id: crypto.randomUUID(),
            name: "AXIOM_TOKEN",
            type: "user",
            description: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          { status: 201 },
        );
      }),
      http.put(`*/api/zero/agents/${AGENT_ID}/user-connectors`, () => {
        authorizeCalled = true;
        return HttpResponse.json({ enabledTypes: ["axiom"] });
      }),
    );

    detachedSetupPage({
      context,
      path: `/connectors/axiom/connect?agentId=${AGENT_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((el) => {
          return el.textContent?.trim() === "Connect";
        }),
      ).toBeDefined();
    });

    const connectBtn = screen.getAllByRole("button").find((el) => {
      return el.textContent?.trim() === "Connect";
    });
    expect(connectBtn).toBeDefined();
    await user.click(connectBtn!);

    await waitFor(() => {
      expect(screen.getByPlaceholderText("xaat-...")).toBeInTheDocument();
    });

    await user.type(
      screen.getByPlaceholderText("xaat-..."),
      "test-token-value",
    );
    const saveBtn = screen.getAllByRole("button").find((el) => {
      return el.textContent?.trim() === "Save";
    });
    expect(saveBtn).toBeDefined();
    await user.click(saveBtn!);

    await waitFor(() => {
      expect(authorizeCalled).toBeTruthy();
    });
  });

  it("shows Google OAuth notice for a Google connector when not connected (CONN-D-060)", async () => {
    detachedSetupPage({ context, path: "/connectors/gmail/connect" });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Gmail to proceed"),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByText(/Google will show a security warning/),
    ).toBeInTheDocument();
    expect(screen.getByText("Advanced")).toBeInTheDocument();
    expect(screen.getByText(/Go to vm0\.ai \(unsafe\)/)).toBeInTheDocument();
  });

  it("shows Google OAuth notice for other Google connectors (CONN-D-061)", async () => {
    detachedSetupPage({ context, path: "/connectors/google-sheets/connect" });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Google Sheets to proceed"),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByText(/Google will show a security warning/),
    ).toBeInTheDocument();
  });

  it("does not show Google OAuth notice for non-Google OAuth connectors (CONN-D-062)", async () => {
    detachedSetupPage({ context, path: "/connectors/github/connect" });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs GitHub to proceed"),
      ).toBeInTheDocument();
    });

    expect(
      screen.queryByText(/Google will show a security warning/),
    ).not.toBeInTheDocument();
  });

  it("does not show Google OAuth notice when Google connector is already connected (CONN-D-063)", async () => {
    mockConnectors([{ type: "gmail" }]);

    detachedSetupPage({ context, path: "/connectors/gmail/connect" });

    await waitFor(() => {
      expect(screen.getByText("Gmail connected")).toBeInTheDocument();
    });

    expect(
      screen.queryByText(/Google will show a security warning/),
    ).not.toBeInTheDocument();
  });

  it("does not call authorize after API token connect when agentId is absent", async () => {
    const user = userEvent.setup();

    let authorizeCalled = false;
    server.use(
      http.post("*/api/zero/secrets", () => {
        return HttpResponse.json(
          {
            id: crypto.randomUUID(),
            name: "AXIOM_TOKEN",
            type: "user",
            description: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          { status: 201 },
        );
      }),
      http.put(`*/api/zero/agents/*/user-connectors`, () => {
        authorizeCalled = true;
        return HttpResponse.json({ enabledTypes: [] });
      }),
    );

    detachedSetupPage({
      context,
      path: "/connectors/axiom/connect",
    });

    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((el) => {
          return el.textContent?.trim() === "Connect";
        }),
      ).toBeDefined();
    });

    const connectBtn = screen.getAllByRole("button").find((el) => {
      return el.textContent?.trim() === "Connect";
    });
    expect(connectBtn).toBeDefined();
    await user.click(connectBtn!);

    await waitFor(() => {
      expect(screen.getByPlaceholderText("xaat-...")).toBeInTheDocument();
    });

    await user.type(
      screen.getByPlaceholderText("xaat-..."),
      "test-token-value",
    );
    const saveBtn = screen.getAllByRole("button").find((el) => {
      return el.textContent?.trim() === "Save";
    });
    expect(saveBtn).toBeDefined();
    await user.click(saveBtn!);

    // Wait for the token to be submitted
    await waitFor(() => {
      expect(screen.getByText("Axiom connected")).toBeInTheDocument();
    });

    expect(authorizeCalled).toBeFalsy();
  });
});
