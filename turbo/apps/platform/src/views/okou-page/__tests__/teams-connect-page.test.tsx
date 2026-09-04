import {
  teamsConnectContract,
  type TeamsConnectBody,
  type TeamsConnectStatus,
} from "@okouai/api-contracts/contracts/teams-connect";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const TEAMS_CLIENT_URL = "msteams://teams.microsoft.com/";

function actionByName(
  role: "button" | "link",
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const action = queryAllByRoleFast(role, container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.replace(/\s+/gu, " ").trim() === name
    );
  });
  if (!action) {
    throw new Error(`Expected ${role} named "${name}"`);
  }
  return action;
}

function unconnectedTeamsStatus(): TeamsConnectStatus {
  return {
    isInstalled: true,
    isConnected: false,
    isAdmin: false,
    installUrl: null,
    connectUrl: "https://teams.example/connect",
    tenantId: "tenant-acme",
    tenantName: "Acme Tenant",
    teamId: "team-core",
    teamName: "Core Team",
    botName: "Acme Assistant",
  };
}

function teamsContextPath(params: Readonly<Record<string, string>>): string {
  return `/settings/teams?${new URLSearchParams(params).toString()}`;
}

test("A Microsoft Teams browser return shows the connected workspace", async () => {
  const browserOpen = context.mocks.browser.open();
  await setupPage({
    context,
    path: teamsContextPath({
      status: "connected",
      tenantId: "tenant-acme",
      tenantName: "Acme Tenant",
      teamsUserId: "teams-user-42",
      teamId: "team-core",
      teamName: "Core Team",
      botName: "Tenant Helper",
    }),
  });

  const connectedHeading = await screen.findByRole("heading", {
    name: "Connected to Microsoft Teams",
  });
  expect(connectedHeading).toBeVisible();
  expect(
    screen.getByText(
      "You are connected to Core Team. Mention @Tenant Helper in Teams to start chatting.",
    ),
  ).toBeVisible();
  expect(actionByName("button", "Open Teams")).toBeVisible();
  expect(actionByName("link", "Back to settings")).toBeVisible();
  expect(browserOpen.calls).toContainEqual({
    url: TEAMS_CLIENT_URL,
    target: "_self",
    features: null,
  });
});

test("A user connects from a Microsoft Teams link", async () => {
  let connectedContext: TeamsConnectBody | null = null;
  const browserOpen = context.mocks.browser.open();
  context.mocks.api(teamsConnectContract.getStatus, ({ respond }) => {
    return respond(200, unconnectedTeamsStatus());
  });
  context.mocks.api(teamsConnectContract.connect, ({ body, respond }) => {
    connectedContext = body;
    return respond(200, {
      success: true,
      connectionId: "teams-connection-core",
      role: "member",
    });
  });
  const expectedContext: TeamsConnectBody = {
    tenantId: "tenant-acme",
    tenantName: "Acme Tenant",
    teamsUserId: "teams-user-42",
    teamsUserDisplayName: "Avery Chen",
    teamsUserPrincipalName: "avery@acme.example",
    teamId: "team-core",
    teamName: "Core Team",
    serviceUrl: "https://smba.trafficmanager.net/amer/",
    conversationId: "conversation-77",
    conversationType: "channel",
    activityId: "activity-88",
    channelId: "channel-99",
    threadId: "thread-100",
  };
  await setupPage({
    context,
    path: teamsContextPath({
      ...expectedContext,
      botName: "Acme Assistant",
    }),
  });

  const connectHeading = await screen.findByRole("heading", {
    name: "Connect Microsoft Teams",
  });
  expect(connectHeading).toBeVisible();
  const connect = actionByName("button", "Connect");
  expect(connect).toBeEnabled();

  click(connect);

  const connectedHeading = await screen.findByRole("heading", {
    name: "Connected to Microsoft Teams",
  });
  expect(connectedHeading).toBeVisible();
  expect(
    screen.getByText(
      "You are connected to Core Team. Mention @Acme Assistant in Teams to start chatting.",
    ),
  ).toBeVisible();
  expect(connectedContext).toStrictEqual(expectedContext);
  expect(actionByName("button", "Open Teams")).toBeVisible();
  expect(actionByName("link", "Back to settings")).toBeVisible();
  expect(browserOpen.calls).toContainEqual({
    url: TEAMS_CLIENT_URL,
    target: "_self",
    features: null,
  });
});
