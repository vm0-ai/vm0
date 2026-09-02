import { integrationsGithubContract } from "@okouai/api-contracts/contracts/integrations-github";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  fill,
  holdElementAnimations,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getAction,
  getIntegrationCard,
  mockSlack,
  mockTeams,
  queryAction,
  setupIntegrationsPage,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
const PHONE_HANDLE = "+15555550123";

async function openPhoneVerification(): Promise<{
  readonly dialog: HTMLElement;
  readonly phoneInput: HTMLElement;
  readonly status: HTMLElement;
}> {
  context.mocks.data.agentPhoneIntegration({
    linked: false,
    agentPhoneNumber: "+19039853128",
    configured: true,
  });
  await setupIntegrationsPage(context);

  const phoneCard = await screen.findByText("Phone");
  expect(phoneCard).toBeInTheDocument();
  click(getAction("button", "Connect phone"));

  const dialog = await screen.findByRole("dialog", { name: "Connect phone" });
  const phoneInput = within(dialog).getByLabelText("Phone number");
  await fill(phoneInput, PHONE_HANDLE);
  click(getAction("button", "Send verification", dialog));
  const status = await within(dialog).findByRole("status");
  expect(status).toHaveTextContent(PHONE_HANDLE);
  return { dialog, phoneInput, status };
}

function publishPhoneLinked(): void {
  context.mocks.data.agentPhoneIntegration({
    linked: true,
    phoneHandle: PHONE_HANDLE,
    agentPhoneNumber: "+19039853128",
    configured: true,
  });
  context.mocks.ably.trigger("agentphone:changed");
}

async function disconnectAndOpenPhone(): Promise<HTMLElement> {
  click(
    await waitFor(() => {
      return getAction("button", "Phone options");
    }),
  );
  click(
    await waitFor(() => {
      return getAction("button", "Disconnect");
    }),
  );
  click(
    await waitFor(() => {
      return getAction("button", "Connect phone");
    }),
  );
  return screen.findByRole("dialog", { name: "Connect phone" });
}

test("Integrations show current status and refresh after GitHub connects", async () => {
  const githubUrl =
    "https://github.com/login/oauth/authorize?client_id=github-oauth-client-id";
  mockSlack(context, {
    isConnected: true,
    isInstalled: true,
    isAdmin: true,
    scopeMismatch: true,
    reinstallUrl: "https://slack.com/oauth/reinstall?state=xyz",
    workspaceName: "VM0 HQ",
  });
  context.mocks.data.githubIntegration(
    context.mocks.data.defaultGithubIntegration({
      isConnected: false,
      connectedGithubUserId: null,
      connectedGithubUsername: null,
      connectUrl: githubUrl,
    }),
  );
  context.mocks.data.agentPhoneIntegration({
    linked: true,
    phoneHandle: "+15555551212",
    agentPhoneNumber: "+19039853128",
    configured: true,
  });
  const providerWindow = context.mocks.browser.authWindow();
  Object.defineProperty(providerWindow, "location", {
    configurable: true,
    value: { href: "" },
  });
  const browserOpen = context.mocks.browser.open(providerWindow);

  await setupIntegrationsPage(context);

  await expect(screen.findByText("Slack")).resolves.toBeInTheDocument();
  expect(screen.getByText("Connected (VM0 HQ)")).toBeInTheDocument();
  expect(screen.getByText(/update permissions/iu)).toBeInTheDocument();
  expect(getIntegrationCard("Phone")).toHaveTextContent("+15555551212");
  const githubCard = getIntegrationCard("GitHub");
  expect(getAction("button", "Connect", githubCard)).toBeInTheDocument();
  expect(screen.queryByText("Feishu")).not.toBeInTheDocument();
  expect(screen.queryByText("Strapi")).not.toBeInTheDocument();

  click(getAction("button", "Connect", githubCard));

  await waitFor(() => {
    const opened = new URL(providerWindow.location.href);
    expect(opened.origin + opened.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(opened.searchParams.get("client_id")).toBe("github-oauth-client-id");
  });
  expect(browserOpen.calls).toStrictEqual([
    {
      url: "about:blank",
      target: "_blank",
      features: "width=600,height=700",
    },
  ]);

  context.mocks.data.githubIntegration(
    context.mocks.data.defaultGithubIntegration({
      isConnected: true,
      connectedGithubUserId: "98765",
      connectedGithubUsername: "octocat",
    }),
  );
  context.mocks.ably.trigger("github:changed");

  await expect(
    screen.findByText("Connected (@octocat)"),
  ).resolves.toBeInTheDocument();
});

test("A workspace member is directed to an admin for GitHub installation", async () => {
  mockSlack(context, { isConnected: true, isInstalled: true, isAdmin: false });
  context.mocks.api(
    integrationsGithubContract.getInstallation,
    ({ respond }) => {
      return respond(404, {
        error: { message: "GitHub installation not found", code: "NOT_FOUND" },
        installUrl: null,
      });
    },
  );

  await setupIntegrationsPage(context);

  const githubCard = await waitFor(() => {
    return getIntegrationCard("GitHub");
  });
  expect(
    within(githubCard).getByText(
      "Ask an organization admin to install the GitHub App",
    ),
  ).toBeInTheDocument();
  expect(queryAction("link", "Install GitHub App", githubCard)).toBeNull();
  expect(queryAction("button", "Connect", githubCard)).toBeNull();
});

test("Open Telegram settings from Integrations", async () => {
  mockSlack(context, { isConnected: true, isInstalled: true, isAdmin: true });

  await setupIntegrationsPage(context);

  await expect(screen.findByText("Telegram")).resolves.toBeInTheDocument();
  click(getAction("link", "Open Telegram settings"));

  await expect(
    waitFor(() => {
      return getAction("link", "Back to integrations");
    }),
  ).resolves.toBeInTheDocument();
});

test("Phone verification closes cleanly when connection completes", async () => {
  const first = await openPhoneVerification();
  const finishAutomaticClose = holdElementAnimations(first.dialog);

  publishPhoneLinked();

  await waitFor(() => {
    expect(getIntegrationCard("Phone")).toHaveTextContent(PHONE_HANDLE);
  });
  expect(first.dialog).toBeVisible();
  expect(first.phoneInput).toHaveValue(PHONE_HANDLE);
  expect(first.status).toBeVisible();
  finishAutomaticClose();
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Connect phone" }),
    ).not.toBeInTheDocument();
  });

  const secondDialog = await disconnectAndOpenPhone();
  const secondInput = within(secondDialog).getByLabelText("Phone number");
  expect(secondInput).toHaveValue("");
  expect(within(secondDialog).queryByRole("status")).toBeNull();
  await fill(secondInput, PHONE_HANDLE);
  click(getAction("button", "Send verification", secondDialog));
  const secondStatus = await within(secondDialog).findByRole("status");
  const finishCancelledClose = holdElementAnimations(secondDialog);

  click(getAction("button", "Cancel", secondDialog));

  expect(secondDialog).toBeVisible();
  expect(secondInput).toHaveValue(PHONE_HANDLE);
  expect(secondStatus).toBeVisible();
  finishCancelledClose();
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Connect phone" }),
    ).not.toBeInTheDocument();
  });
  publishPhoneLinked();
  await waitFor(() => {
    expect(getIntegrationCard("Phone")).toHaveTextContent(PHONE_HANDLE);
  });
  expect(
    screen.queryByRole("dialog", { name: "Connect phone" }),
  ).not.toBeInTheDocument();

  const reopened = await disconnectAndOpenPhone();
  expect(within(reopened).getByLabelText("Phone number")).toHaveValue("");
  expect(within(reopened).queryByRole("status")).toBeNull();
});

test("An admin can begin Microsoft Teams installation", async () => {
  const browserOpen = context.mocks.browser.open();
  mockSlack(context, { isConnected: true, isInstalled: true, isAdmin: true });
  mockTeams(context, { isConnected: false, isInstalled: false, isAdmin: true });

  await setupIntegrationsPage(context);

  const teamsCard = await waitFor(() => {
    return getIntegrationCard("Microsoft Teams");
  });
  const install = getAction("button", "Install in Teams", teamsCard);
  expect(
    screen.getByText(
      "Connect your Microsoft account, then install the Teams app",
    ),
  ).toBeInTheDocument();

  click(install);

  expect(browserOpen.calls).toHaveLength(1);
  const opened = browserOpen.calls[0];
  expect(opened?.target).toBe("_blank");
  const url = new URL(opened?.url ?? "", window.location.origin);
  expect(url.pathname).toBe("/api/teams/oauth/connect");
  expect(url.searchParams.get("orgId")).toBe("org_1");
  expect(url.searchParams.get("userId")).toBe("user_1");
});

test("Microsoft Teams offers Connect after installation", async () => {
  mockSlack(context, { isConnected: true, isInstalled: true, isAdmin: true });
  mockTeams(context, { isConnected: false, isInstalled: true, isAdmin: true });

  await setupIntegrationsPage(context);

  const teamsCard = await waitFor(() => {
    return getIntegrationCard("Microsoft Teams");
  });
  expect(getAction("button", "Connect", teamsCard)).toBeInTheDocument();
  expect(queryAction("button", "Install in Teams", teamsCard)).toBeNull();
});

test("Microsoft Teams shows its connected team name", async () => {
  mockSlack(context, { isConnected: true, isInstalled: true, isAdmin: true });
  mockTeams(context, {
    isConnected: true,
    isInstalled: true,
    isAdmin: true,
    tenantName: "VM0 Tenant",
    teamName: "Core Team",
  });

  await setupIntegrationsPage(context);

  await expect(
    screen.findByText("Microsoft Teams"),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText("Connected (Core Team)")).toBeInTheDocument();
  expect(getAction("link", "Install GitHub App")).toBeInTheDocument();
});

test("Microsoft Teams does not expose a tenant identifier as a display name", async () => {
  mockSlack(context, { isConnected: true, isInstalled: true, isAdmin: true });
  mockTeams(context, {
    isConnected: true,
    isInstalled: true,
    isAdmin: true,
    tenantId: "tenant-123",
    tenantName: null,
    teamName: null,
  });

  await setupIntegrationsPage(context);

  const teamsCard = await waitFor(() => {
    return getIntegrationCard("Microsoft Teams");
  });
  await waitFor(() => {
    expect(within(teamsCard).getByText("Connected")).toBeInTheDocument();
  });
  expect(
    within(teamsCard).queryByText("Connected (tenant-123)"),
  ).not.toBeInTheDocument();
});

test("Uninstalling Microsoft Teams requires confirmation", async () => {
  mockSlack(context, { isConnected: true, isInstalled: true, isAdmin: true });
  mockTeams(context, { isConnected: false, isInstalled: true, isAdmin: true });

  await setupIntegrationsPage(context);

  await expect(
    screen.findByText("Microsoft Teams"),
  ).resolves.toBeInTheDocument();
  click(getAction("button", "More Microsoft Teams options"));
  click(getAction("button", "Uninstall Microsoft Teams"));

  await expect(
    screen.findByRole("dialog", {
      name: "Uninstall Microsoft Teams integration?",
    }),
  ).resolves.toBeInTheDocument();
});
