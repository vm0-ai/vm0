import {
  integrationsSlackContract,
  type SlackOrgStatus,
} from "@okouai/api-contracts/contracts/integrations-slack";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { pathname, search } from "../../../signals/location.ts";
import { AGENT_ID, context, mockAgent } from "./chat-composer-test-helpers.ts";

function mockSlackStatus(overrides: Partial<SlackOrgStatus>): void {
  const status: SlackOrgStatus = {
    isConnected: false,
    isInstalled: false,
    isAdmin: true,
    installUrl: null,
    connectUrl: null,
    reinstallUrl: null,
    scopeMismatch: false,
    workspaceName: null,
    environment: {
      requiredSecrets: [],
      requiredVars: [],
      missingSecrets: [],
      missingVars: [],
    },
    ...overrides,
  };
  context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
    return respond(200, status);
  });
}

function setupGrowthEntry(slack: Partial<SlackOrgStatus>): void {
  mockAgent();
  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role: "admin",
  });
  mockSlackStatus(slack);
  detachedSetupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });
}

describe("home growth entry", () => {
  it("leads with Slack before installation and opens the works page", async () => {
    const user = userEvent.setup();
    setupGrowthEntry({ isConnected: false, isInstalled: false });

    const entry = await screen.findByTestId("growth-entry");
    expect(entry).toHaveTextContent("Add Zero in Slack");

    await user.click(entry);
    const menu = await screen.findByRole("menu");
    const slackAction = within(menu).getByTestId("growth-slack");
    expect(slackAction).toHaveTextContent("Add Zero in Slack");
    expect(slackAction).toHaveTextContent("Connect");

    await user.click(slackAction);
    await waitFor(() => {
      expect(pathname()).toBe("/works");
    });
  });

  it("leads with invite after Slack installation and opens People", async () => {
    const user = userEvent.setup();
    setupGrowthEntry({ isConnected: false, isInstalled: true });

    const entry = await screen.findByTestId("growth-entry");
    expect(entry).toHaveTextContent("Invite member");

    await user.click(entry);
    const menu = await screen.findByRole("menu");
    const slackStatus = within(menu).getByTestId("growth-slack");
    expect(slackStatus).toHaveTextContent("Zero is in Slack");
    expect(slackStatus).not.toHaveTextContent("Connect");

    await user.click(within(menu).getByTestId("growth-invite"));
    await expect(screen.findByRole("dialog")).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(search()).toContain("settings=people");
    });
  });

  it("opens usage from the credit balance", async () => {
    const user = userEvent.setup();
    setupGrowthEntry({ isConnected: true, isInstalled: true });

    await user.click(await screen.findByTestId("growth-entry"));
    const menu = await screen.findByRole("menu");
    const credits = await within(menu).findByTestId("growth-credits");

    await user.click(credits);
    await expect(screen.findByRole("dialog")).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(search()).toContain("settings=usage");
    });
  });
});
