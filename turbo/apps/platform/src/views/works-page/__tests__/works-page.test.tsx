import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { type SlackOrgStatus, zeroIntegrationsSlackContract } from "@vm0/core";
import { createMockApi } from "../../../mocks/msw-contract.ts";

const context = testContext();
const mockApi = createMockApi(context);

function mockSlackAPI(overrides: Partial<SlackOrgStatus> = {}) {
  const defaults: SlackOrgStatus = {
    isConnected: true,
    isInstalled: true,
    workspaceName: "Test Workspace",
    isAdmin: true,
    installUrl: "/api/zero/integrations/slack/install",
    connectUrl: "/api/zero/integrations/slack/connect",
    agentOrgSlug: "test-org",
    environment: {
      requiredSecrets: [],
      requiredVars: [],
      missingSecrets: [],
      missingVars: [],
    },
  };

  server.use(
    mockApi(zeroIntegrationsSlackContract.getStatus, ({ respond }) => {
      return respond(200, { ...defaults, ...overrides });
    }),
  );
}

function renderWorksPage() {
  detachedSetupPage({ context, path: "/works" });
}

describe("zero works page - header", () => {
  it("should render page title with agent name", async () => {
    mockSlackAPI();
    await renderWorksPage();

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Where Zero works" }),
      ).toBeInTheDocument();
    });
  });

  it("should render subtitle with agent name", async () => {
    mockSlackAPI();
    await renderWorksPage();

    await waitFor(() => {
      expect(
        screen.getByText(/connect with zero through these channels/i),
      ).toBeInTheDocument();
    });
  });
});

describe("zero works page - slack card connected state", () => {
  it("should show Connected badge when slack is connected", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true });
    await renderWorksPage();

    await waitFor(() => {
      expect(screen.getByText("Connected")).toBeInTheDocument();
    });
  });

  it("should show Slack card label", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true });
    await renderWorksPage();

    await waitFor(() => {
      expect(screen.getByText("Slack")).toBeInTheDocument();
    });
  });

  it("should show more options button when connected", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    await renderWorksPage();

    await waitFor(() => {
      expect(screen.getByLabelText("More options")).toBeInTheDocument();
    });
  });

  it("should show Disconnect option in popover when connected", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    await renderWorksPage();

    await waitFor(() => {
      expect(screen.getByLabelText("More options")).toBeInTheDocument();
    });

    click(screen.getByLabelText("More options"));

    await waitFor(() => {
      expect(screen.getByText("Disconnect")).toBeInTheDocument();
    });
  });

  it("should show Uninstall option for admin in popover", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    await renderWorksPage();

    await waitFor(() => {
      expect(screen.getByLabelText("More options")).toBeInTheDocument();
    });

    click(screen.getByLabelText("More options"));

    await waitFor(() => {
      expect(screen.getByText("Uninstall")).toBeInTheDocument();
    });
  });

  it("should not show Install or Connect buttons when already connected", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true });
    await renderWorksPage();

    await waitFor(() => {
      expect(screen.getByText("Connected")).toBeInTheDocument();
    });

    expect(screen.queryByText("Install to Slack")).not.toBeInTheDocument();
    expect(screen.queryByText("Connect")).not.toBeInTheDocument();
  });

  it("should show default description when installed", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    await renderWorksPage();

    await waitFor(() => {
      expect(
        screen.getByText(/team communication and collaboration/i),
      ).toBeInTheDocument();
    });
  });
});

describe("zero works page - slack not installed", () => {
  it("should show Install to Slack button for admin when not installed", async () => {
    mockSlackAPI({ isConnected: false, isInstalled: false, isAdmin: true });
    await renderWorksPage();

    await waitFor(() => {
      expect(screen.getByText("Install to Slack")).toBeInTheDocument();
    });
  });

  it("should not show Install button for non-admin when not installed", async () => {
    mockSlackAPI({ isConnected: false, isInstalled: false, isAdmin: false });
    await renderWorksPage();

    await waitFor(() => {
      expect(screen.getByText("Slack")).toBeInTheDocument();
    });

    expect(screen.queryByText("Install to Slack")).not.toBeInTheDocument();
  });

  it("should show admin prompt message for non-admin when not installed", async () => {
    mockSlackAPI({ isConnected: false, isInstalled: false, isAdmin: false });
    await renderWorksPage();

    await waitFor(() => {
      expect(
        screen.getByText(/ask your admin to install/i),
      ).toBeInTheDocument();
    });
  });

  it("should not show Connected badge when not installed", async () => {
    mockSlackAPI({ isConnected: false, isInstalled: false, isAdmin: true });
    await renderWorksPage();

    await waitFor(() => {
      expect(screen.getByText("Install to Slack")).toBeInTheDocument();
    });

    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  });
});

describe("zero works page - slack installed but not connected", () => {
  it("should show Connect button when installed but not connected", async () => {
    mockSlackAPI({ isConnected: false, isInstalled: true });
    await renderWorksPage();

    await waitFor(() => {
      expect(screen.getByText("Connect")).toBeInTheDocument();
    });
  });

  it("should not show Connected badge when not connected", async () => {
    mockSlackAPI({ isConnected: false, isInstalled: true });
    await renderWorksPage();

    await waitFor(() => {
      expect(screen.getByText("Connect")).toBeInTheDocument();
    });

    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  });
});

describe("zero works page - uninstall confirmation dialog", () => {
  it("should show uninstall confirmation dialog when Uninstall is clicked", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    await renderWorksPage();

    await waitFor(() => {
      expect(screen.getByLabelText("More options")).toBeInTheDocument();
    });

    click(screen.getByLabelText("More options"));

    await waitFor(() => {
      expect(screen.getByText("Uninstall")).toBeInTheDocument();
    });

    click(screen.getByText("Uninstall"));

    await waitFor(() => {
      expect(
        screen.getByText("Uninstall Slack integration?"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText(/This will remove the Slack integration/),
    ).toBeInTheDocument();
  });

  it("should close dialog when Cancel is clicked", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    await renderWorksPage();

    await waitFor(() => {
      expect(screen.getByLabelText("More options")).toBeInTheDocument();
    });

    click(screen.getByLabelText("More options"));

    await waitFor(() => {
      expect(screen.getByText("Uninstall")).toBeInTheDocument();
    });

    click(screen.getByText("Uninstall"));

    await waitFor(() => {
      expect(
        screen.getByText("Uninstall Slack integration?"),
      ).toBeInTheDocument();
    });

    click(screen.getByText("Cancel"));

    await waitFor(() => {
      expect(
        screen.queryByText("Uninstall Slack integration?"),
      ).not.toBeInTheDocument();
    });
  });

  it("should call uninstall API when confirming uninstall", async () => {
    let uninstallCalled = false;

    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    server.use(
      mockApi(
        zeroIntegrationsSlackContract.disconnect,
        ({ query, respond }) => {
          if (query.action === "uninstall") {
            uninstallCalled = true;
          }
          return respond(200, { ok: true });
        },
      ),
    );

    await renderWorksPage();

    await waitFor(() => {
      expect(screen.getByLabelText("More options")).toBeInTheDocument();
    });

    click(screen.getByLabelText("More options"));

    await waitFor(() => {
      expect(screen.getByText("Uninstall")).toBeInTheDocument();
    });

    click(screen.getByText("Uninstall"));

    await waitFor(() => {
      expect(
        screen.getByText("Uninstall Slack integration?"),
      ).toBeInTheDocument();
    });

    // Click "Uninstall" button in dialog to confirm
    const dialog = screen.getByRole("dialog");
    click(within(dialog).getByText("Uninstall"));

    await waitFor(() => {
      expect(uninstallCalled).toBeTruthy();
    });
  });
});

describe("zero works page - admin vs non-admin permissions", () => {
  it("should not show more options button for non-admin when installed but not connected", async () => {
    mockSlackAPI({
      isConnected: false,
      isInstalled: true,
      isAdmin: false,
    });
    await renderWorksPage();

    await waitFor(() => {
      expect(screen.getByText("Connect")).toBeInTheDocument();
    });

    expect(screen.queryByLabelText("More options")).not.toBeInTheDocument();
  });

  it("should show more options for non-admin when connected (for disconnect)", async () => {
    mockSlackAPI({
      isConnected: true,
      isInstalled: true,
      isAdmin: false,
    });
    await renderWorksPage();

    await waitFor(() => {
      expect(screen.getByLabelText("More options")).toBeInTheDocument();
    });

    click(screen.getByLabelText("More options"));

    await waitFor(() => {
      expect(screen.getByText("Disconnect")).toBeInTheDocument();
    });

    // Non-admin should not see Uninstall
    expect(screen.queryByText("Uninstall")).not.toBeInTheDocument();
  });
});

describe("zero works page - disconnect", () => {
  it("should call disconnect API when Disconnect is clicked", async () => {
    let disconnectCalled = false;

    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    server.use(
      mockApi(
        zeroIntegrationsSlackContract.disconnect,
        ({ query, respond }) => {
          if (!query.action) {
            disconnectCalled = true;
          }
          return respond(200, { ok: true });
        },
      ),
    );

    await renderWorksPage();

    await waitFor(() => {
      expect(screen.getByLabelText("More options")).toBeInTheDocument();
    });

    click(screen.getByLabelText("More options"));

    await waitFor(() => {
      expect(screen.getByText("Disconnect")).toBeInTheDocument();
    });

    click(screen.getByText("Disconnect"));

    await waitFor(() => {
      expect(disconnectCalled).toBeTruthy();
    });
  });
});
