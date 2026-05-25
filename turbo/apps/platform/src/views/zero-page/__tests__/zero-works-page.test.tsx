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
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import {
  detachedSetupPage,
  click,
  fill,
} from "../../../__tests__/page-helper.ts";
import {
  zeroIntegrationsSlackContract,
  type SlackOrgStatus,
} from "@vm0/api-contracts/contracts/zero-integrations-slack";
import { integrationsGithubContract } from "@vm0/api-contracts/contracts/integrations-github";
import { toast } from "@vm0/ui/components/ui/sonner";
import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { pathname$, searchParams$ } from "../../../signals/route.ts";
import { setMockAgentPhoneIntegration } from "../../../mocks/handlers/api-integrations-agentphone.ts";
import { setMockConnectors } from "../../../mocks/handlers/api-connectors.ts";
import {
  createDefaultMockGithubIntegration,
  getMockGithubIntegration,
  setMockGithubIntegration,
} from "../../../mocks/handlers/api-integrations-github.ts";
import { hasSubscription, triggerAblyEvent } from "../../../mocks/ably.ts";

const context = testContext();
const mockApi = createMockApi(context);
const GITHUB_CONNECT_URL =
  "https://github.com/login/oauth/authorize?client_id=github-oauth-client-id";
const GITHUB_ADMIN_INSTALL_TOOLTIP = "Ask an org admin to install GitHub.";

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

function renderWorksPage(options?: {
  readonly featureSwitches?: Partial<Record<FeatureSwitchKey, boolean>>;
}) {
  detachedSetupPage({
    context,
    path: "/works",
    featureSwitches: options?.featureSwitches,
  });
}

function getGithubCard(): HTMLElement {
  const card = screen.getByText("GitHub").closest(".zero-card");
  if (!(card instanceof HTMLElement)) {
    throw new Error("GitHub card not found");
  }
  return card;
}

function createMockAuthWindow() {
  return { closed: false, close: vi.fn(), location: { href: "" } };
}

function createGithubConnector(): ConnectorResponse {
  return {
    id: "d0000000-0000-4000-a000-000000000001",
    type: "github",
    authMethod: "oauth",
    externalId: "98765",
    externalUsername: "testuser",
    externalEmail: "test@example.com",
    oauthScopes: ["repo", "project", "workflow"],
    needsReconnect: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
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

describe("works page - GitHub integration card", () => {
  it("shows an error toast from the redirect query and clears it", async () => {
    const errorSpy = vi.spyOn(toast, "error").mockImplementation(() => {
      return "" as ReturnType<typeof toast.error>;
    });
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });

    detachedSetupPage({
      context,
      path: "/works?error=The+code+passed+is+incorrect+or+expired.",
    });

    await waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith(
        "The code passed is incorrect or expired.",
      );
    });
    expect(context.store.get(searchParams$).has("error")).toBeFalsy();

    errorSpy.mockRestore();
  });

  it("hides the GitHub card when the feature switch is off", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    renderWorksPage();

    await waitFor(() => {
      expect(screen.getByText("Slack")).toBeInTheDocument();
      expect(screen.queryByText("GitHub")).not.toBeInTheDocument();
    });
  });

  it("shows the GitHub install action when no installation exists", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    renderWorksPage({
      featureSwitches: { [FeatureSwitchKey.GitHubIntegration]: true },
    });

    await waitFor(() => {
      expect(
        within(getGithubCard()).getByText("Install GitHub"),
      ).toBeInTheDocument();
      expect(
        within(getGithubCard()).getByText(
          "Run agents from GitHub issue and PR labels or @Zero",
        ),
      ).toBeInTheDocument();
    });
  });

  it("shows disabled GitHub install guidance when org members cannot install", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    server.use(
      mockApi(integrationsGithubContract.getInstallation, ({ respond }) => {
        return respond(404, {
          error: {
            message: "No GitHub installation found",
            code: "NOT_FOUND",
          },
          installUrl: null,
        });
      }),
    );
    renderWorksPage({
      featureSwitches: { [FeatureSwitchKey.GitHubIntegration]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });

    const githubCard = getGithubCard();
    const installButton = within(githubCard)
      .getByText("Install GitHub")
      .closest("button");
    if (!installButton) {
      throw new Error("GitHub install button not found");
    }
    expect(installButton).toBeDisabled();
    expect(installButton).toHaveAttribute(
      "title",
      GITHUB_ADMIN_INSTALL_TOOLTIP,
    );

    await userEvent.hover(
      within(githubCard).getByTestId("github-install-admin-required"),
    );
    const tooltip = (
      await screen.findAllByText(GITHUB_ADMIN_INSTALL_TOOLTIP)
    ).find((element) => {
      return element.dataset.state === "delayed-open";
    });
    if (!tooltip) {
      throw new Error("GitHub admin install tooltip not found");
    }
    expect(tooltip).toBeVisible();
  });

  it("refreshes the GitHub card from the page-level realtime subscription", async () => {
    const successSpy = vi.spyOn(toast, "success").mockImplementation(() => {
      return "" as ReturnType<typeof toast.success>;
    });
    const integration = createDefaultMockGithubIntegration({
      isConnected: false,
      connectedGithubUserId: null,
      connectedGithubUsername: null,
      connectUrl: GITHUB_CONNECT_URL,
    });
    setMockGithubIntegration(integration);
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });

    renderWorksPage({
      featureSwitches: { [FeatureSwitchKey.GitHubIntegration]: true },
    });

    await waitFor(() => {
      expect(within(getGithubCard()).getByText("Connect")).toBeInTheDocument();
      expect(hasSubscription("github:changed")).toBeTruthy();
    });

    setMockGithubIntegration({
      ...integration,
      isConnected: true,
      connectedGithubUserId: "98765",
      connectedGithubUsername: "octocat",
    });
    triggerAblyEvent("github:changed");

    await waitFor(() => {
      expect(
        within(getGithubCard()).getByTestId("github-connected-indicator"),
      ).toHaveTextContent("Connected (@octocat)");
    });
    await waitFor(() => {
      expect(successSpy).toHaveBeenCalledWith("GitHub connected successfully");
      expect(hasSubscription("github:changed")).toBeTruthy();
    });
    successSpy.mockRestore();
  });

  it("connects the GitHub integration through the integration OAuth flow", async () => {
    const integration = createDefaultMockGithubIntegration({
      isConnected: false,
      connectedGithubUserId: null,
      connectUrl: GITHUB_CONNECT_URL,
    });
    setMockGithubIntegration(integration);
    setMockConnectors([]);
    const mockWindow = createMockAuthWindow();
    vi.spyOn(window, "open").mockReturnValue(mockWindow as unknown as Window);
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });

    renderWorksPage({
      featureSwitches: { [FeatureSwitchKey.GitHubIntegration]: true },
    });

    await waitFor(() => {
      expect(within(getGithubCard()).getByText("Connect")).toBeInTheDocument();
    });
    click(within(getGithubCard()).getByText("Connect"));

    await waitFor(() => {
      const openedUrl = new URL(mockWindow.location.href);
      expect(openedUrl.origin).toBe("https://github.com");
      expect(openedUrl.pathname).toBe("/login/oauth/authorize");
      expect(hasSubscription("github:changed")).toBeTruthy();
    });

    setMockGithubIntegration({
      ...integration,
      isConnected: true,
      connectedGithubUserId: "98765",
    });
    triggerAblyEvent("github:changed");

    await waitFor(() => {
      expect(getMockGithubIntegration()?.isConnected).toBeTruthy();
      expect(
        within(getGithubCard()).getByTestId("github-connected-indicator"),
      ).toBeInTheDocument();
    });
  });

  it("reconnects GitHub OAuth when the GitHub connector already exists", async () => {
    const integration = createDefaultMockGithubIntegration({
      isConnected: false,
      connectedGithubUserId: null,
      connectUrl: GITHUB_CONNECT_URL,
    });
    setMockGithubIntegration(integration);
    setMockConnectors([createGithubConnector()]);
    const mockWindow = createMockAuthWindow();
    vi.spyOn(window, "open").mockReturnValue(mockWindow as unknown as Window);
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });

    renderWorksPage({
      featureSwitches: { [FeatureSwitchKey.GitHubIntegration]: true },
    });

    await waitFor(() => {
      expect(within(getGithubCard()).getByText("Connect")).toBeInTheDocument();
    });
    click(within(getGithubCard()).getByText("Connect"));

    await waitFor(() => {
      const openedUrl = new URL(mockWindow.location.href);
      expect(openedUrl.origin).toBe("https://github.com");
      expect(openedUrl.pathname).toBe("/login/oauth/authorize");
      expect(hasSubscription("github:changed")).toBeTruthy();
    });

    setMockGithubIntegration({
      ...integration,
      isConnected: true,
      connectedGithubUserId: "98765",
    });
    triggerAblyEvent("github:changed");

    await waitFor(() => {
      expect(getMockGithubIntegration()?.isConnected).toBeTruthy();
      expect(
        within(getGithubCard()).getByTestId("github-connected-indicator"),
      ).toBeInTheDocument();
    });
  });

  it("shows GitHub uninstall when the installation is not connected", async () => {
    const integration = createDefaultMockGithubIntegration({
      isConnected: false,
      connectedGithubUserId: null,
    });
    setMockGithubIntegration({
      ...integration,
      installation: { ...integration.installation, isAdmin: true },
    });
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });

    renderWorksPage({
      featureSwitches: { [FeatureSwitchKey.GitHubIntegration]: true },
    });

    await waitFor(() => {
      expect(
        within(getGithubCard()).getByLabelText("GitHub options"),
      ).toBeInTheDocument();
    });
    click(within(getGithubCard()).getByLabelText("GitHub options"));

    await waitFor(() => {
      expect(screen.getByText("Uninstall")).toBeInTheDocument();
      expect(screen.queryByText("Disconnect")).not.toBeInTheDocument();
    });
  });

  it("shows the connected GitHub username", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    setMockGithubIntegration(
      createDefaultMockGithubIntegration({
        isConnected: true,
        connectedGithubUsername: "octocat",
      }),
    );
    renderWorksPage({
      featureSwitches: { [FeatureSwitchKey.GitHubIntegration]: true },
    });

    await waitFor(() => {
      expect(
        within(getGithubCard()).getByText("Connected (@octocat)"),
      ).toBeInTheDocument();
      expect(
        within(getGithubCard()).getByTestId("github-installation-target"),
      ).toHaveTextContent("(Installed on @vm0-test)");
    });
  });

  it("opens GitHub settings from the options menu", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    setMockGithubIntegration(
      createDefaultMockGithubIntegration({
        isConnected: true,
      }),
    );
    renderWorksPage({
      featureSwitches: { [FeatureSwitchKey.GitHubIntegration]: true },
    });

    await waitFor(() => {
      expect(
        within(getGithubCard()).getByLabelText("GitHub options"),
      ).toBeInTheDocument();
    });
    click(within(getGithubCard()).getByLabelText("GitHub options"));
    click(await screen.findByLabelText("Manage GitHub"));

    await waitFor(() => {
      expect(context.store.get(pathname$)).toBe("/settings/github");
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
      expect(
        screen.getByText("Route Telegram messages to agents"),
      ).toBeInTheDocument();
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

describe("works page - Phone integration card", () => {
  it("shows Phone connection status on the list page", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    setMockAgentPhoneIntegration({
      linked: true,
      phoneHandle: "+15555551212",
      agentPhoneNumber: "+19039853128",
      configured: true,
    });
    detachedSetupPage({ context, path: "/works" });

    await waitFor(() => {
      expect(screen.getByText("Phone")).toBeInTheDocument();
      expect(screen.getByText("iMessage or SMS to")).toBeInTheDocument();
      expect(screen.getByText("+1 (903) 985-3128")).toBeInTheDocument();
      expect(
        screen.getByTestId("agentphone-connected-indicator"),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("agentphone-connected-indicator"),
      ).toHaveTextContent("+15555551212");
      expect(screen.getByLabelText("Phone options")).toBeInTheDocument();
    });
  });

  it("starts verification from the list page and refreshes when the phone connects", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    setMockAgentPhoneIntegration({
      linked: false,
      agentPhoneNumber: "+19039853128",
      configured: true,
    });
    detachedSetupPage({ context, path: "/works" });

    await waitFor(() => {
      expect(screen.getByLabelText("Connect phone")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Connect phone"));
    const input = await screen.findByTestId("agentphone-phone-input");
    expect(
      screen.getByText(/SMS and MMS replies may not be delivered reliably/u),
    ).toBeInTheDocument();
    await fill(input, "+1 (555) 555-1212");

    await waitFor(() => {
      expect(
        screen.getByTestId("agentphone-normalized-phone"),
      ).toHaveTextContent("+15555551212");
    });

    click(screen.getByText("Send verification"));

    await waitFor(() => {
      expect(
        screen.getByText(/Verification text sent to \+15555551212/i),
      ).toBeInTheDocument();
      expect(screen.getByText("Connecting...")).toBeDisabled();
    });
    await waitFor(() => {
      expect(hasSubscription("agentphone:changed")).toBeTruthy();
    });

    setMockAgentPhoneIntegration({
      linked: true,
      phoneHandle: "+15555551212",
      agentPhoneNumber: "+19039853128",
      configured: true,
    });
    triggerAblyEvent("agentphone:changed");

    await waitFor(() => {
      expect(
        screen.getByTestId("agentphone-connected-indicator"),
      ).toHaveTextContent("+15555551212");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("validates phone number format before sending verification from the list page", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    setMockAgentPhoneIntegration({
      linked: false,
      agentPhoneNumber: "+19039853128",
      configured: true,
    });
    detachedSetupPage({ context, path: "/works" });

    await waitFor(() => {
      expect(screen.getByLabelText("Connect phone")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Connect phone"));
    const input = await screen.findByTestId("agentphone-phone-input");
    await fill(input, "555-1212");

    expect(
      screen.queryByText(
        "Enter a phone number with country code, like +1 555 555 1212.",
      ),
    ).not.toBeInTheDocument();

    fireEvent.blur(input);
    await waitFor(() => {
      expect(
        screen.getByText(
          "Enter a phone number with country code, like +1 555 555 1212.",
        ),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Send verification")).toBeDisabled();

    fireEvent.focus(input);
    await waitFor(() => {
      expect(
        screen.queryByText(
          "Enter a phone number with country code, like +1 555 555 1212.",
        ),
      ).not.toBeInTheDocument();
    });
  });

  it("disconnects a linked phone account from the list page", async () => {
    mockSlackAPI({ isConnected: true, isInstalled: true, isAdmin: true });
    setMockAgentPhoneIntegration({
      linked: true,
      phoneHandle: "+15555551212",
      agentPhoneNumber: "+19039853128",
      configured: true,
    });
    detachedSetupPage({ context, path: "/works" });

    await waitFor(() => {
      expect(
        screen.getByTestId("agentphone-connected-indicator"),
      ).toHaveTextContent("+15555551212");
    });

    click(screen.getByLabelText("Phone options"));
    click(await screen.findByLabelText("Disconnect phone"));

    await waitFor(() => {
      expect(screen.getByLabelText("Connect phone")).toBeInTheDocument();
      expect(
        screen.queryByTestId("agentphone-connected-indicator"),
      ).not.toBeInTheDocument();
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
