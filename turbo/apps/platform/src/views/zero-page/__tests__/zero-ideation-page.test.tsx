import { screen, waitFor } from "@testing-library/react";
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

function cardByTitle(title: string): HTMLElement {
  const card = screen.getByText(title).closest(".zero-card");
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

    await waitFor(() => {
      expect(screen.getAllByText("Ideas & Use Cases")[0]).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText("Daily standup report")).toBeInTheDocument();
    });

    await fill(screen.getByLabelText("Search use cases"), "RevenueCat");

    await waitFor(() => {
      expect(
        screen.getByText("RevenueCat subscription digest"),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText("Daily standup report")).not.toBeInTheDocument();

    click(screen.getByText("RevenueCat subscription digest"));

    const composer = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
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

    const card = await waitFor(() => {
      return cardByTitle("Daily standup report");
    });

    expect(card.querySelectorAll("img")).toHaveLength(2);
  });

  it("hides connector-only use cases when catalog omits all refs", async () => {
    mockConnectorCatalogStatus([]);

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/ideas`,
    });

    await waitFor(() => {
      expect(screen.getByText("Browser screenshots")).toBeInTheDocument();
    });
    expect(screen.queryByText("Daily standup report")).not.toBeInTheDocument();

    await fill(screen.getByLabelText("Search use cases"), "RevenueCat");

    await waitFor(() => {
      expect(
        screen.queryByText("RevenueCat subscription digest"),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.getByText("No use cases match your search."),
    ).toBeInTheDocument();
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
