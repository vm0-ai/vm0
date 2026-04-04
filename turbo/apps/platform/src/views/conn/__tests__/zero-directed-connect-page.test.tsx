/**
 * Tests for the /connectors/:type/connect page (ZeroDirectedConnectPage).
 *
 * Entry point: setupPage({ path: "/connectors/:type/connect" })
 * Mock (external): connectors API and secrets API via MSW
 * Real (internal): signals, components, rendering
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { mockConnectors } from "../../zero-page/__tests__/zero-connectors-page-test-helpers.ts";

const context = testContext();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("directed connect page - display states", () => {
  it("shows loading indicator while connectors are being fetched (CONN-D-043)", async () => {
    server.use(
      http.get("*/api/zero/connectors", () => {
        return new Promise<never>(() => {
          // Never resolves — keeps component in loading state
        });
      }),
    );

    await setupPage({ context, path: "/connectors/gmail/connect" });

    // During loading the heading is not rendered — the spinner takes its place
    expect(
      screen.queryByText("Zero needs Gmail to proceed"),
    ).not.toBeInTheDocument();

    // The spinner element (animate-spin class) is present
    const spinner = document.querySelector(".animate-spin");
    expect(spinner).toBeInTheDocument();
  });

  it("shows connected checkmark when connector is already connected (CONN-D-044)", async () => {
    mockConnectors([{ type: "github" }]);

    await setupPage({ context, path: "/connectors/github/connect" });

    await waitFor(() => {
      expect(screen.getByText("GitHub connected")).toBeInTheDocument();
    });

    // "Connected" label appears alongside the checkmark
    expect(screen.getByText("Connected")).toBeInTheDocument();

    // The connect button is absent in connected state
    expect(
      screen.queryByRole("button", { name: "Connect" }),
    ).not.toBeInTheDocument();
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
        screen.getByRole("button", { name: "Connect" }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(screen.getByPlaceholderText("xaat-...")).toBeInTheDocument();
    });

    await user.type(screen.getByPlaceholderText("xaat-..."), "bad-token");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByText("Invalid API token")).toBeInTheDocument();
    });
  });
});

describe("directed connect page - logo display", () => {
  it("shows VM0 logo but not connector icon while loading (CONN-C-046)", async () => {
    server.use(
      http.get("*/api/zero/connectors", () => {
        return new Promise<never>(() => {
          // Never resolves — keeps component in loading state
        });
      }),
    );

    await setupPage({ context, path: "/connectors/gmail/connect" });

    // The VM0 brand logo is always shown
    expect(screen.getByLabelText("VM0")).toBeInTheDocument();

    // The spinner is shown — meaning isLoading is true
    const spinner = document.querySelector(".animate-spin");
    expect(spinner).toBeInTheDocument();

    // The heading that contains the connector name is NOT shown during loading
    // (it is hidden inside the {isLoading ? spinner : <>heading + icon</>} branch)
    expect(
      screen.queryByText("Zero needs Gmail to proceed"),
    ).not.toBeInTheDocument();
  });
});

describe("directed connect page - interactions", () => {
  it("connect button opens OAuth flow for OAuth-enabled connector (CONN-I-047)", async () => {
    const user = userEvent.setup();
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValue({ closed: true } as Window);

    await setupPage({ context, path: "/connectors/gmail/connect" });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Connect" }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(openSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/zero/connectors/gmail/authorize"),
      "_blank",
      expect.any(String),
    );
  });

  it("api token form accepts typed input (CONN-I-048)", async () => {
    const user = userEvent.setup();

    await setupPage({ context, path: "/connectors/axiom/connect" });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Connect" }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(screen.getByPlaceholderText("xaat-...")).toBeInTheDocument();
    });

    await user.type(screen.getByPlaceholderText("xaat-..."), "my-axiom-token");

    expect(screen.getByPlaceholderText("xaat-...")).toHaveValue(
      "my-axiom-token",
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
        screen.getByRole("button", { name: "Connect" }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(screen.getByPlaceholderText("xaat-...")).toBeInTheDocument();
    });

    await user.type(
      screen.getByPlaceholderText("xaat-..."),
      "test-token-value",
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(capturedBody).toBeDefined();
      expect(capturedBody?.name).toBe("AXIOM_TOKEN");
      expect(capturedBody?.value).toBe("test-token-value");
    });
  });
});
