/**
 * Display, conditional, and interaction tests for the /works page (ZeroWorksPage component).
 *
 * Tests Slack integration status, buttons, dropdown, dialogs, and API calls via setupPage
 * following platform testing principles:
 * - Entry point: setupPage({ path: "/works" })
 * - Mock (external): HTTP via MSW
 * - Real (internal): All signals, components, rendering
 */

import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import {
  zeroIntegrationsSlackContract,
  type SlackOrgStatus,
} from "@vm0/api-contracts/contracts/zero-integrations-slack";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { pathname$ } from "../../../signals/route.ts";
import { setMockAgentPhoneIntegration } from "../../../mocks/handlers/api-integrations-agentphone.ts";

const context = testContext();
const mockApi = createMockApi(context);

function mockSlackAPI(overrides: Partial<SlackOrgStatus> = {}) {
  const defaults: SlackOrgStatus = {
    isConnected: false,
    isInstalled: false,
    isAdmin: false,
    installUrl: null,
    connectUrl: null,
    reinstallUrl: null,
    scopeMismatch: false,
    workspaceName: null,
    agentOrgSlug: null,
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

describe("works page - slack integration status display", () => {
  it("renders the Slack integration card on the works page (CONN-D-058)", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    await renderWorksPage();

    // When data is loaded and the user is connected+admin, the More options button
    // appears — confirming the Slack card rendered with integration status.
    await waitFor(() => {
      expect(screen.getByLabelText("More options")).toBeInTheDocument();
    });
  });

  it("shows a connected indicator when Slack is connected (CONN-D-059)", async () => {
    mockSlackAPI({
      isConnected: true,
      isInstalled: true,
      isAdmin: false,
      workspaceName: "VM0 HQ",
    });
    await renderWorksPage();

    await waitFor(() => {
      expect(
        screen.getByTestId("slack-connected-indicator"),
      ).toBeInTheDocument();
      expect(screen.getByTestId("slack-connected-indicator")).toHaveTextContent(
        "Connected (VM0 HQ)",
      );
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
      expect(screen.getByText(/update permissions/i)).toBeInTheDocument();
    });
  });
});

describe("works page - telegram integration card", () => {
  it("renders Telegram below Slack", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    renderWorksPage();

    await waitFor(() => {
      expect(screen.getByText("Slack")).toBeInTheDocument();
      expect(screen.getByText("Telegram")).toBeInTheDocument();
      expect(screen.queryByTestId("telegram-beta-badge")).toBeNull();
    });
  });

  it("opens Telegram settings from the Telegram card", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    renderWorksPage();

    await waitFor(() => {
      expect(
        screen.getByLabelText("Open Telegram settings"),
      ).toBeInTheDocument();
    });
    click(screen.getByLabelText("Open Telegram settings"));

    await waitFor(() => {
      expect(context.store.get(pathname$)).toBe("/settings/telegram");
    });
  });
});

describe("works page - AgentPhone integration card", () => {
  it("hides AgentPhone when the feature switch is off", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    detachedSetupPage({
      context,
      path: "/works",
      featureSwitches: { [FeatureSwitchKey.AgentPhoneAppUi]: false },
    });

    await waitFor(() => {
      expect(screen.getByText("Telegram")).toBeInTheDocument();
      expect(screen.queryByText("AgentPhone")).not.toBeInTheDocument();
    });
  });

  it("shows AgentPhone connection status and opens settings", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    setMockAgentPhoneIntegration({
      linked: true,
      phoneHandle: "+15555551212",
      agentPhoneNumber: "+19039853128",
      configured: true,
    });
    detachedSetupPage({
      context,
      path: "/works",
      featureSwitches: { [FeatureSwitchKey.AgentPhoneAppUi]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("AgentPhone")).toBeInTheDocument();
      expect(screen.getByText("Text Zero at +19039853128")).toBeInTheDocument();
      expect(screen.queryByText(/Connected as/i)).not.toBeInTheDocument();
      expect(
        screen.getByTestId("agentphone-connected-indicator"),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("agentphone-connected-indicator"),
      ).toHaveTextContent("Connected (+15555551212)");
      expect(
        screen.getByLabelText("Open AgentPhone settings"),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Open AgentPhone settings"));

    await waitFor(() => {
      expect(context.store.get(pathname$)).toBe("/settings/agentphone");
    });
  });

  it("opens AgentPhone settings when the user is unlinked", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    setMockAgentPhoneIntegration({
      linked: false,
      agentPhoneNumber: "+19039853128",
      configured: true,
    });
    detachedSetupPage({
      context,
      path: "/works",
      featureSwitches: { [FeatureSwitchKey.AgentPhoneAppUi]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByLabelText("Open AgentPhone settings"),
      ).toBeInTheDocument();
      expect(screen.queryByLabelText("Connect AgentPhone")).toBeNull();
    });

    click(screen.getByLabelText("Open AgentPhone settings"));

    await waitFor(() => {
      expect(context.store.get(pathname$)).toBe("/settings/agentphone");
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
      expect(screen.getByText(/install to slack/i)).toBeInTheDocument();
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
      expect(screen.getByText(/^connect$/i)).toBeInTheDocument();
    });
  });
});

describe("works page - install to slack interaction", () => {
  it("clicking Install to Slack opens the install OAuth URL in a new tab (CONN-I-062)", async () => {
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
      expect(screen.getByTestId("slack-install-button")).toBeInTheDocument();
    });

    click(screen.getByTestId("slack-install-button"));

    expect(openSpy).toHaveBeenCalledWith(
      expect.stringContaining("slack.com/oauth/install"),
      "_blank",
    );
  });
});

describe("works page - more options dropdown", () => {
  it("more options popover contains Disconnect and Uninstall items (CONN-I-063)", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    await renderWorksPage();

    await waitFor(() => {
      expect(screen.getByLabelText("More options")).toBeInTheDocument();
    });

    click(screen.getByLabelText("More options"));

    await waitFor(() => {
      expect(screen.getByText("Disconnect")).toBeInTheDocument();
      expect(screen.getByText("Uninstall")).toBeInTheDocument();
    });
  });

  it("clicking Uninstall opens confirmation dialog with Cancel and Uninstall buttons (CONN-I-064)", async () => {
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

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/cancel/i)).toBeInTheDocument();
    expect(within(dialog).getAllByText(/uninstall/i).length).toBeGreaterThan(0);
  });

  it("clicking Disconnect calls the disconnect API (CONN-I-066)", async () => {
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

describe("works page - disconnect loading state", () => {
  it("shows Disconnecting… while disconnect API is pending", async () => {
    const disconnectDeferred = createDeferredPromise<void>(context.signal);

    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    server.use(
      mockApi(zeroIntegrationsSlackContract.disconnect, ({ respond }) => {
        return disconnectDeferred.promise.then(() => {
          return respond(200, { ok: true });
        });
      }),
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
      expect(screen.getByText("Disconnecting…")).toBeInTheDocument();
    });

    disconnectDeferred.resolve();

    await waitFor(() => {
      expect(screen.queryByText("Disconnecting…")).not.toBeInTheDocument();
    });
  });
});

describe("works page - uninstall loading state", () => {
  it("shows Uninstalling… and disables buttons while uninstall API is pending", async () => {
    const uninstallDeferred = createDeferredPromise<void>(context.signal);

    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    server.use(
      mockApi(zeroIntegrationsSlackContract.disconnect, ({ respond }) => {
        return uninstallDeferred.promise.then(() => {
          return respond(200, { ok: true });
        });
      }),
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

    const dialog = await screen.findByRole("dialog");
    click(within(dialog).getByText("Uninstall"));

    // Dialog stays open with loading text and disabled buttons
    await waitFor(() => {
      expect(within(dialog).getByText("Uninstalling…")).toBeInTheDocument();
    });
    expect(within(dialog).getByText("Cancel")).toBeDisabled();
    expect(within(dialog).getByText("Uninstalling…")).toBeDisabled();

    uninstallDeferred.resolve();

    // Dialog closes after completion
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});

describe("works page - update permissions interaction", () => {
  it("clicking Update Permissions opens the reinstall OAuth URL in a new tab (CONN-I-065)", async () => {
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
      expect(screen.getByText(/update permissions/i)).toBeInTheDocument();
    });

    click(screen.getByText(/update permissions/i));

    expect(openSpy).toHaveBeenCalledWith(
      expect.stringContaining("slack.com/oauth/reinstall"),
      "_blank",
    );
  });
});
