import { billingUsagePackCreditsContract } from "@okouai/api-contracts/contracts/billing";
import {
  integrationsSlackContract,
  type SlackOrgStatus,
} from "@okouai/api-contracts/contracts/integrations-slack";
import { FeatureSwitchKey } from "@okouai/core";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { pathname, search } from "../../../signals/location.ts";
import { AGENT_ID, context, mockAgent } from "./chat-composer-test-helpers.ts";
import { PLACEHOLDER } from "./chat-test-helpers.ts";

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

interface GrowthEntrySetupOptions {
  readonly growthEntryEnabled?: boolean;
  readonly role?: "admin" | "member";
  readonly usagePackPlansEnabled?: boolean;
}

function setupGrowthEntry(
  slack: Partial<SlackOrgStatus>,
  options: GrowthEntrySetupOptions = {},
): void {
  const {
    growthEntryEnabled = true,
    role = "admin",
    usagePackPlansEnabled = false,
  } = options;
  mockAgent();
  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role,
  });
  mockSlackStatus(slack);
  detachedSetupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.HomeGrowthEntry]: growthEntryEnabled,
      [FeatureSwitchKey.UsagePackPlans]: usagePackPlansEnabled,
    },
  });
}

describe("home growth entry", () => {
  it("keeps the existing invite entry when its feature switch is disabled", async () => {
    const user = userEvent.setup();
    setupGrowthEntry(
      { isConnected: false, isInstalled: false },
      { growthEntryEnabled: false },
    );

    const invite = await screen.findByTestId("invite-button");
    await waitFor(() => {
      expect(invite).not.toHaveAttribute("aria-hidden");
    });
    expect(invite).toHaveTextContent("Invite people");
    expect(screen.queryByTestId("growth-entry")).not.toBeInTheDocument();

    await user.click(invite);
    await expect(screen.findByRole("dialog")).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(search()).toContain("settings=people");
    });
  });

  it("hides the growth entry from non-admin members", async () => {
    setupGrowthEntry(
      { isConnected: false, isInstalled: false },
      { role: "member" },
    );

    await screen.findByPlaceholderText(PLACEHOLDER);
    expect(screen.queryByTestId("growth-entry")).not.toBeInTheDocument();
    expect(screen.queryByTestId("invite-button")).not.toBeInTheDocument();
  });

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
    const otherChannels = within(menu).getByText("Telegram and phone");
    expect(otherChannels).toBeInTheDocument();
    expect(otherChannels.parentElement?.querySelector("img")).toHaveAttribute(
      "src",
      expect.stringContaining("telegram-2d9ff5d01146.svg"),
    );

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

  it("requests usage-pack billing data only after the menu opens", async () => {
    const user = userEvent.setup();
    let usagePackCreditRequests = 0;
    context.mocks.api(billingUsagePackCreditsContract.get, ({ respond }) => {
      usagePackCreditRequests += 1;
      return respond(200, {
        totalCredits: 20_400,
        purchasedCredits: 20_000,
        bonusCredits: 400,
        creditGrants: [],
      });
    });
    setupGrowthEntry(
      { isConnected: true, isInstalled: true },
      { usagePackPlansEnabled: true },
    );

    const entry = await screen.findByTestId("growth-entry");
    expect(usagePackCreditRequests).toBe(0);

    await user.click(entry);
    const menu = await screen.findByRole("menu");
    await within(menu).findByTestId("growth-credits");
    expect(usagePackCreditRequests).toBe(1);
  });
});
