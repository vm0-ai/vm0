/**
 * Display, conditional, and interaction tests for the /works page (ZeroWorksPage component).
 *
 * Tests Slack integration status, buttons, dropdown, dialogs, and API calls via setupPage
 * following platform testing principles:
 * - Entry point: setupPage({ path: "/works" })
 * - Mock (external): HTTP via MSW
 * - Real (internal): All signals, components, rendering
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

beforeEach(() => {
  vi.clearAllMocks();
});

function mockSlackAPI(overrides: Record<string, unknown> = {}) {
  const defaults = {
    isConnected: false,
    isInstalled: false,
    isAdmin: false,
    installUrl: null,
    connectUrl: null,
    reinstallUrl: null,
    scopeMismatch: false,
    workspaceName: null,
    defaultAgentId: null,
    agentOrgSlug: null,
    environment: {
      requiredSecrets: [],
      requiredVars: [],
      missingSecrets: [],
      missingVars: [],
    },
  };
  server.use(
    http.get("*/api/zero/integrations/slack", () => {
      return HttpResponse.json({ ...defaults, ...overrides });
    }),
  );
}

async function renderWorksPage() {
  await setupPage({ context, path: "/works" });
}

describe("works page - slack integration status display", () => {
  it("renders the Slack integration card on the works page (CONN-D-058)", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    await renderWorksPage();

    // When data is loaded and the user is connected+admin, the More options button
    // appears — confirming the Slack card rendered with integration status.
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "More options" }),
      ).toBeInTheDocument();
    });
  });

  it("shows a connected indicator when Slack is connected (CONN-D-059)", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: false });
    await renderWorksPage();

    await waitFor(() => {
      expect(
        screen.getByTestId("slack-connected-indicator"),
      ).toBeInTheDocument();
    });
  });

  it("shows permissions update alert when scope mismatch exists (CONN-D-061)", async () => {
    mockSlackAPI({
      isConnected: true,
      isInstalled: true,
      isAdmin: true,
      scopeMismatch: true,
      reinstallUrl: "https://slack.com/oauth/reinstall?state=xyz",
    });
    await renderWorksPage();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /update permissions/i }),
      ).toBeInTheDocument();
    });
  });
});

describe("works page - install and connect button visibility", () => {
  it("shows Install to Slack button when not installed and user is admin (CONN-C-060)", async () => {
    mockSlackAPI({
      isConnected: false,
      isInstalled: false,
      isAdmin: true,
      installUrl: "https://slack.com/oauth/install?state=abc",
    });
    await renderWorksPage();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /install to slack/i }),
      ).toBeInTheDocument();
    });
  });

  it("shows Connect button when installed but not connected (CONN-C-060)", async () => {
    mockSlackAPI({
      isConnected: false,
      isInstalled: true,
      isAdmin: false,
      connectUrl: "https://slack.com/oauth/connect?state=xyz",
    });
    await renderWorksPage();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /^connect$/i }),
      ).toBeInTheDocument();
    });
  });
});

describe("works page - install to slack interaction", () => {
  it("clicking Install to Slack opens the install OAuth URL in a new tab (CONN-I-062)", async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => {
      return null;
    });

    mockSlackAPI({
      isConnected: false,
      isInstalled: false,
      isAdmin: true,
      installUrl: "https://slack.com/oauth/install?state=abc",
    });
    await renderWorksPage();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /install to slack/i }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /install to slack/i }));

    expect(openSpy).toHaveBeenCalledWith(
      expect.stringContaining("slack.com/oauth/install"),
      "_blank",
    );
  });
});

describe("works page - more options dropdown", () => {
  it("more options popover contains Disconnect and Uninstall items (CONN-I-063)", async () => {
    const user = userEvent.setup();
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    await renderWorksPage();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "More options" }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "More options" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Disconnect" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Uninstall" }),
      ).toBeInTheDocument();
    });
  });

  it("clicking Uninstall opens confirmation dialog with Cancel and Uninstall buttons (CONN-I-064)", async () => {
    const user = userEvent.setup();
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    await renderWorksPage();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "More options" }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "More options" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Uninstall" }),
      ).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Uninstall" }));

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("button", { name: /cancel/i }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: /uninstall/i }),
    ).toBeInTheDocument();
  });

  it("clicking Disconnect calls the disconnect API (CONN-I-066)", async () => {
    const user = userEvent.setup();
    let disconnectCalled = false;

    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    server.use(
      http.delete("*/api/zero/integrations/slack", ({ request }) => {
        const url = new URL(request.url);
        if (!url.searchParams.get("action")) {
          disconnectCalled = true;
        }
        return HttpResponse.json({ ok: true });
      }),
    );

    await renderWorksPage();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "More options" }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "More options" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Disconnect" }),
      ).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Disconnect" }));

    await waitFor(() => {
      expect(disconnectCalled).toBeTruthy();
    });
  });
});

describe("works page - update permissions interaction", () => {
  it("clicking Update Permissions opens the reinstall OAuth URL in a new tab (CONN-I-065)", async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => {
      return null;
    });

    mockSlackAPI({
      isConnected: true,
      isInstalled: true,
      isAdmin: true,
      scopeMismatch: true,
      reinstallUrl: "https://slack.com/oauth/reinstall?state=xyz",
    });
    await renderWorksPage();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /update permissions/i }),
      ).toBeInTheDocument();
    });

    await user.click(
      screen.getByRole("button", { name: /update permissions/i }),
    );

    expect(openSpy).toHaveBeenCalledWith(
      expect.stringContaining("slack.com/oauth/reinstall"),
      "_blank",
    );
  });
});
