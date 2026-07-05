import { screen } from "@testing-library/react";
import {
  zeroConnectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setIdeationActiveTab$ } from "../../../signals/zero-page/zero-ideation.ts";
import { PLACEHOLDER } from "./chat-test-helpers.ts";

const context = testContext();

const agentId = "c0000000-0000-4000-a000-000000000001";

function publicConnectorStatusItem(
  connectorRef: string,
): PublicConnectorCatalogStatusItem {
  return {
    connectorRef,
    label: connectorRef,
    description: `${connectorRef} public description`,
    category: "data-automation-infrastructure",
    generation: [],
    tags: [],
    authMethods: [],
    permissionSummary: {
      hasPermissions: false,
      permissionCount: 0,
      hasCategories: false,
      hasDefaultPolicyOverrides: false,
    },
    connection: null,
    connected: false,
    connectionStatus: "not-connected",
    scopeMismatch: false,
    authMethodSupportsRefresh: false,
    tokenExpiresAt: null,
    singleAuthCodeAuthMethodId: null,
    connectNotice: null,
  };
}

function mockConnectorCatalogStatus(connectorRefs: readonly string[]): void {
  context.mocks.api(zeroConnectorCatalogContract.status, ({ respond }) => {
    return respond(200, {
      connectors: connectorRefs.map(publicConnectorStatusItem),
    });
  });
}

async function cardByTitle(title: string): Promise<HTMLElement> {
  const titleElement = await screen.findByText(title);
  const card = titleElement.closest(".zero-card");
  if (!(card instanceof HTMLElement)) {
    throw new Error(`${title} card not found`);
  }
  return card;
}

describe("zero ideation page", () => {
  it("filters use cases and starts an agent chat from a selected idea", async () => {
    detachedSetupPage({
      context,
      path: `/agents/${agentId}/ideas`,
    });

    const pageTitles = await screen.findAllByText("Ideas & Use Cases");
    expect(pageTitles[0]).toBeInTheDocument();
    await expect(
      screen.findByText("Daily standup report"),
    ).resolves.toBeInTheDocument();

    await fill(screen.getByLabelText("Search use cases"), "RevenueCat");

    await expect(
      screen.findByText("RevenueCat subscription digest"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByText("Daily standup report")).not.toBeInTheDocument();

    click(screen.getByText("RevenueCat subscription digest"));

    const composer = (await screen.findByPlaceholderText(
      PLACEHOLDER,
    )) as HTMLTextAreaElement;
    expect(composer).toHaveValue(
      "Set up a daily RevenueCat digest that tracks new subscriptions, renewals, and cancellations in Google Sheets and alerts on Slack for churn spikes",
    );
  });

  it("renders only catalog-visible connector chips for use cases", async () => {
    mockConnectorCatalogStatus(["github", "slack"]);

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/ideas`,
    });

    const card = await cardByTitle("Daily standup report");

    expect(card.querySelectorAll("img")).toHaveLength(2);
  });

  it("hides connector-only use cases when catalog omits all refs", async () => {
    mockConnectorCatalogStatus([]);

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/ideas`,
    });

    await expect(
      screen.findByText("Browser screenshots"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByText("Daily standup report")).not.toBeInTheDocument();

    await fill(screen.getByLabelText("Search use cases"), "RevenueCat");

    await expect(
      screen.findByText("No use cases match your search."),
    ).resolves.toBeInTheDocument();
    expect(
      screen.queryByText("RevenueCat subscription digest"),
    ).not.toBeInTheDocument();
  });

  it("falls back to all use cases when the selected tab is hidden by catalog filtering", async () => {
    mockConnectorCatalogStatus([]);
    context.store.set(setIdeationActiveTab$, "reports");

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/ideas`,
    });

    await expect(
      screen.findByText("Browser screenshots"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByText("Reports")).not.toBeInTheDocument();
    expect(
      screen.queryByText("No use cases match your search."),
    ).not.toBeInTheDocument();
  });

  it("does not render connector-dependent suggested prompts when catalog is empty", async () => {
    mockConnectorCatalogStatus([]);

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/chat`,
    });

    const ideasTitle = await screen.findByText("Ideas & use cases");
    const ideasButton = ideasTitle.closest("button");
    if (!(ideasButton instanceof HTMLElement)) {
      throw new Error("Ideas & use cases button not found");
    }
    const promptGrid = ideasButton.parentElement;
    if (!(promptGrid instanceof HTMLElement)) {
      throw new Error("Suggested prompt grid not found");
    }

    expect(queryAllByRoleFast("button", promptGrid)).toHaveLength(1);
    expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
  });
});
