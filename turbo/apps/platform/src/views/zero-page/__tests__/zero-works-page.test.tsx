import { describe, expect, it } from "vitest";
import { screen, waitFor, fireEvent, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

function mockSlackAPI(
  overrides: {
    isConnected?: boolean;
    isInstalled?: boolean;
    isAdmin?: boolean;
    installUrl?: string | null;
    connectUrl?: string | null;
  } = {},
) {
  const data = {
    isConnected: overrides.isConnected ?? false,
    isInstalled: overrides.isInstalled ?? false,
    isAdmin: overrides.isAdmin ?? false,
    workspaceName: "Test Workspace",
    installUrl: overrides.installUrl ?? null,
    connectUrl: overrides.connectUrl ?? null,
    defaultAgentName: "zero",
    agentOrgSlug: "test-org",
    environment: {
      requiredSecrets: [],
      requiredVars: [],
      missingSecrets: [],
      missingVars: [],
    },
  };

  server.use(
    http.get("*/api/zero/integrations/slack", () => {
      return HttpResponse.json(data);
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

async function renderWorksPage() {
  await setupPage({ context, path: "/works" });
}

describe("zero works page - header", () => {
  it("should render page title with agent name", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true });
    await renderWorksPage();

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Where Zero works" }),
      ).toBeInTheDocument();
    });
  });

  it("should render page subtitle with agent name", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true });
    await renderWorksPage();

    await waitFor(() => {
      expect(
        screen.getByText("Connect with Zero through these channels"),
      ).toBeInTheDocument();
    });
  });
});

describe("zero works page - slack card status", () => {
  it("should show Connected badge when slack is connected", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    await renderWorksPage();

    await waitFor(() => {
      expect(screen.getByText("Connected")).toBeInTheDocument();
    });
  });

  it("should not show Connected badge when slack is not connected", async () => {
    mockSlackAPI({
      isConnected: false,
      isInstalled: true,
      isAdmin: true,
      connectUrl: "/api/slack/connect",
    });
    await renderWorksPage();

    await waitFor(() => {
      expect(screen.getByText("Slack")).toBeInTheDocument();
    });

    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  });

  it("should show description text for non-admin when not installed", async () => {
    mockSlackAPI({ isConnected: false, isInstalled: false, isAdmin: false });
    await renderWorksPage();

    await waitFor(() => {
      expect(
        screen.getByText("Ask your admin to install the Slack integration"),
      ).toBeInTheDocument();
    });
  });

  it("should show default description when installed", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    await renderWorksPage();

    await waitFor(() => {
      expect(
        screen.getByText("Team communication and collaboration"),
      ).toBeInTheDocument();
    });
  });
});

describe("zero works page - action buttons", () => {
  it("should show Install to Slack button for admin when not installed", async () => {
    mockSlackAPI({
      isConnected: false,
      isInstalled: false,
      isAdmin: true,
      installUrl: "/api/slack/install",
    });
    await renderWorksPage();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Install to Slack/i }),
      ).toBeInTheDocument();
    });
  });

  it("should not show Install button for non-admin when not installed", async () => {
    mockSlackAPI({ isConnected: false, isInstalled: false, isAdmin: false });
    await renderWorksPage();

    await waitFor(() => {
      expect(screen.getByText("Slack")).toBeInTheDocument();
    });

    expect(
      screen.queryByRole("button", { name: /Install to Slack/i }),
    ).not.toBeInTheDocument();
  });

  it("should show Connect button when installed but not connected", async () => {
    mockSlackAPI({
      isConnected: false,
      isInstalled: true,
      isAdmin: false,
      connectUrl: "/api/slack/connect",
    });
    await renderWorksPage();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Connect" }),
      ).toBeInTheDocument();
    });
  });

  it("should not show Connect button when already connected", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    await renderWorksPage();

    await waitFor(() => {
      expect(screen.getByText("Connected")).toBeInTheDocument();
    });

    expect(
      screen.queryByRole("button", { name: "Connect" }),
    ).not.toBeInTheDocument();
  });
});

describe("zero works page - more options menu", () => {
  it("should show more options button when installed and connected", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    await renderWorksPage();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "More options" }),
      ).toBeInTheDocument();
    });
  });

  it("should show Disconnect option in popover when connected", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    await renderWorksPage();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "More options" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "More options" }));

    await waitFor(() => {
      expect(screen.getByText("Disconnect")).toBeInTheDocument();
    });
  });

  it("should show Uninstall option in popover for admin", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    await renderWorksPage();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "More options" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "More options" }));

    await waitFor(() => {
      expect(screen.getByText("Uninstall")).toBeInTheDocument();
    });
  });

  it("should not show Uninstall option for non-admin", async () => {
    mockSlackAPI({
      isConnected: true,
      isInstalled: true,
      isAdmin: false,
    });
    await renderWorksPage();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "More options" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "More options" }));

    await waitFor(() => {
      expect(screen.getByText("Disconnect")).toBeInTheDocument();
    });

    expect(screen.queryByText("Uninstall")).not.toBeInTheDocument();
  });

  it("should send DELETE request when Disconnect is clicked", async () => {
    let deleteCalled = false;

    server.use(
      http.get("*/api/zero/integrations/slack", () => {
        return HttpResponse.json({
          isConnected: true,
          isInstalled: true,
          isAdmin: true,
          workspaceName: "Test Workspace",
          installUrl: null,
          connectUrl: null,
          defaultAgentName: "zero",
          agentOrgSlug: "test-org",
          environment: {
            requiredSecrets: [],
            requiredVars: [],
            missingSecrets: [],
            missingVars: [],
          },
        });
      }),
      http.delete("*/api/zero/integrations/slack", () => {
        deleteCalled = true;
        return HttpResponse.json({ ok: true });
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );

    await renderWorksPage();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "More options" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "More options" }));

    await waitFor(() => {
      expect(screen.getByText("Disconnect")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Disconnect"));

    await waitFor(() => {
      expect(deleteCalled).toBeTruthy();
    });
  });
});

describe("zero works page - uninstall confirmation dialog", () => {
  it("should open uninstall confirmation dialog when Uninstall is clicked", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    await renderWorksPage();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "More options" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "More options" }));

    await waitFor(() => {
      expect(screen.getByText("Uninstall")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Uninstall"));

    await waitFor(() => {
      expect(
        screen.getByText("Uninstall Slack integration?"),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByText(
        /This will remove the Slack integration for your entire workspace/,
      ),
    ).toBeInTheDocument();
  });

  it("should close dialog when Cancel is clicked", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    await renderWorksPage();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "More options" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "More options" }));

    await waitFor(() => {
      expect(screen.getByText("Uninstall")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Uninstall"));

    await waitFor(() => {
      expect(
        screen.getByText("Uninstall Slack integration?"),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(
        screen.queryByText("Uninstall Slack integration?"),
      ).not.toBeInTheDocument();
    });
  });

  it("should send uninstall request when confirmed", async () => {
    let uninstallCalled = false;

    server.use(
      http.get("*/api/zero/integrations/slack", () => {
        return HttpResponse.json({
          isConnected: true,
          isInstalled: true,
          isAdmin: true,
          workspaceName: "Test Workspace",
          installUrl: null,
          connectUrl: null,
          defaultAgentName: "zero",
          agentOrgSlug: "test-org",
          environment: {
            requiredSecrets: [],
            requiredVars: [],
            missingSecrets: [],
            missingVars: [],
          },
        });
      }),
      http.delete("*/api/zero/integrations/slack", ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("action") === "uninstall") {
          uninstallCalled = true;
        }
        return HttpResponse.json({ ok: true });
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );

    await renderWorksPage();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "More options" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "More options" }));

    await waitFor(() => {
      expect(screen.getByText("Uninstall")).toBeInTheDocument();
    });

    // Click "Uninstall" in popover to open dialog
    fireEvent.click(screen.getByText("Uninstall"));

    await waitFor(() => {
      expect(
        screen.getByText("Uninstall Slack integration?"),
      ).toBeInTheDocument();
    });

    // Click "Uninstall" button in dialog to confirm
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Uninstall" }));

    await waitFor(() => {
      expect(uninstallCalled).toBeTruthy();
    });
  });
});
