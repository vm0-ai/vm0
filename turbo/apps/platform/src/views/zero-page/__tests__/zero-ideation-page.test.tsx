import {
  screen,
  waitFor,
  waitForElementToBeRemoved,
  within,
} from "@testing-library/react";
import { chatThreadsContract } from "@vm0/api-contracts/contracts/chat-threads";
import {
  zeroConnectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { reloadConnectors$ } from "../../../signals/external/connectors.ts";
import { pathname } from "../../../signals/location.ts";
import { setIdeationActiveTab$ } from "../../../signals/zero-page/zero-ideation.ts";
import { PLACEHOLDER, threadListSnapshot } from "./chat-test-helpers.ts";

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

function mockUnreadShortcutThreads(): void {
  const currentAgentUnreadThreadId = "b0000000-0000-4000-a000-000000000901";
  const currentAgentRunningThreadId = "b0000000-0000-4000-a000-000000000902";
  const otherAgentUnreadThreadId = "b0000000-0000-4000-a000-000000000903";
  const otherAgentId = "c0000000-0000-4000-a000-000000000099";
  const threads = [
    {
      id: currentAgentUnreadThreadId,
      title: "Unread research brief",
      agent: { id: agentId, avatarUrl: null },
      createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-06-01T00:03:00Z",
      running: false,
      pinnedAt: null,
    },
    {
      id: currentAgentRunningThreadId,
      title: "Running incident follow-up",
      agent: { id: agentId, avatarUrl: null },
      createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-06-01T00:02:00Z",
      running: true,
      pinnedAt: null,
    },
    {
      id: otherAgentUnreadThreadId,
      title: "Other agent unread chat",
      agent: { id: otherAgentId, avatarUrl: null },
      createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-06-01T00:01:00Z",
      running: false,
      pinnedAt: null,
    },
  ];

  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, {
      chatThreads: threadListSnapshot(threads),
      latestEventId: null,
    });
  });
  context.mocks.api(chatThreadsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
  context.mocks.api(chatThreadsContract.activeIds, ({ respond }) => {
    return respond(200, { threadIds: [currentAgentRunningThreadId] });
  });
  context.mocks.api(chatThreadsContract.unreads, ({ respond }) => {
    return respond(200, {
      unreads: [
        {
          threadId: currentAgentUnreadThreadId,
          unreadAt: "2026-06-01T00:03:00Z",
        },
        {
          threadId: currentAgentRunningThreadId,
          unreadAt: "2026-06-01T00:02:00Z",
        },
        {
          threadId: otherAgentUnreadThreadId,
          unreadAt: "2026-06-01T00:01:00Z",
        },
      ],
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

async function suggestedPromptGrid(): Promise<HTMLElement> {
  const ideasTitle = await screen.findByText("Ideas & use cases");
  const ideasButton = ideasTitle.closest("button");
  if (!(ideasButton instanceof HTMLElement)) {
    throw new Error("Ideas & use cases button not found");
  }
  const promptGrid = ideasButton.parentElement;
  if (!(promptGrid instanceof HTMLElement)) {
    throw new Error("Suggested prompt grid not found");
  }
  return promptGrid;
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

  it("renders use case connector chips when all connectors are catalog-visible", async () => {
    mockConnectorCatalogStatus([
      "github",
      "sentry",
      "axiom",
      "plausible",
      "slack",
    ]);

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/ideas`,
    });

    const card = await cardByTitle("Daily standup report");

    expect(card.querySelectorAll("img")).toHaveLength(5);
  });

  it("hides use cases when any required connector is omitted from catalog", async () => {
    mockConnectorCatalogStatus(["github", "slack"]);

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/ideas`,
    });

    await expect(
      screen.findByText("GitHub progress weekly"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByText("Daily standup report")).not.toBeInTheDocument();
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

  it("keeps the last resolved ideas page catalog while a reload is pending", async () => {
    mockConnectorCatalogStatus([]);

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/ideas`,
    });

    await expect(
      screen.findByText("Browser screenshots"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByText("Daily standup report")).not.toBeInTheDocument();

    const catalogRequested = context.mocks.deferred<void>();
    const catalogReady = context.mocks.deferred<void>();
    context.mocks.api(
      zeroConnectorCatalogContract.status,
      async ({ respond }) => {
        catalogRequested.resolve();
        await catalogReady.promise;
        return respond(200, {
          connectors: ["github", "sentry", "axiom", "plausible", "slack"].map(
            publicConnectorStatusItem,
          ),
        });
      },
    );
    context.store.set(reloadConnectors$);

    await catalogRequested.promise;
    expect(screen.queryByText("Daily standup report")).not.toBeInTheDocument();

    catalogReady.resolve();
    await expect(
      screen.findByText("Daily standup report"),
    ).resolves.toBeInTheDocument();
  });

  it("does not treat pending catalog status as an empty catalog", async () => {
    const catalogReady = context.mocks.deferred<void>();
    context.mocks.api(
      zeroConnectorCatalogContract.status,
      async ({ respond }) => {
        await catalogReady.promise;
        return respond(200, {
          connectors: [],
        });
      },
    );

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/ideas`,
    });

    await expect(
      screen.findByText("Daily standup report"),
    ).resolves.toBeInTheDocument();

    catalogReady.resolve();
    await waitForElementToBeRemoved(() => {
      return screen.queryByText("Daily standup report");
    });
    expect(screen.getByText("Browser screenshots")).toBeInTheDocument();
  });

  it("fails closed when catalog status errors on the ideas page", async () => {
    const catalogReady = context.mocks.deferred<void>();
    context.mocks.api(
      zeroConnectorCatalogContract.status,
      async ({ respond }) => {
        await catalogReady.promise;
        return respond(403, {
          error: { message: "Forbidden", code: "FORBIDDEN" },
        });
      },
    );

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/ideas`,
    });

    await expect(
      screen.findByText("Daily standup report"),
    ).resolves.toBeInTheDocument();

    catalogReady.resolve();
    await waitForElementToBeRemoved(() => {
      return screen.queryByText("Daily standup report");
    });
    expect(screen.getByText("Browser screenshots")).toBeInTheDocument();
  });

  it("does not reuse stale catalog data after an ideas page catalog reload errors", async () => {
    mockConnectorCatalogStatus([
      "github",
      "sentry",
      "axiom",
      "plausible",
      "slack",
    ]);

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/ideas`,
    });

    await expect(
      screen.findByText("Daily standup report"),
    ).resolves.toBeInTheDocument();

    const catalogReady = context.mocks.deferred<void>();
    context.mocks.api(
      zeroConnectorCatalogContract.status,
      async ({ respond }) => {
        await catalogReady.promise;
        return respond(403, {
          error: { message: "Forbidden", code: "FORBIDDEN" },
        });
      },
    );
    context.store.set(reloadConnectors$);

    expect(screen.getByText("Daily standup report")).toBeInTheDocument();
    catalogReady.resolve();
    await waitForElementToBeRemoved(() => {
      return screen.queryByText("Daily standup report");
    });
    expect(screen.getByText("Browser screenshots")).toBeInTheDocument();
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

    const promptGrid = await suggestedPromptGrid();

    expect(queryAllByRoleFast("button", promptGrid)).toHaveLength(1);
    expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
  });

  it("shows current-agent unread chat shortcuts on mobile behind the feature switch", async () => {
    mockConnectorCatalogStatus([]);
    mockUnreadShortcutThreads();

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/chat`,
      featureSwitches: {
        [FeatureSwitchKey.MobileUnreadChatThreadShortcuts]: true,
      },
    });

    const unreadRegion = await screen.findByRole("region", {
      name: "Unread chats",
    });
    expect(unreadRegion).toHaveClass("md:hidden");
    expect(within(unreadRegion).getByText("2")).toBeInTheDocument();
    expect(
      within(unreadRegion).getByText("Unread research brief"),
    ).toBeInTheDocument();
    expect(
      within(unreadRegion).getByText("Running incident follow-up"),
    ).toBeInTheDocument();
    expect(within(unreadRegion).getByText("Running now")).toBeInTheDocument();
    expect(
      screen.queryByText("Other agent unread chat"),
    ).not.toBeInTheDocument();

    const shortcut = within(unreadRegion)
      .getByText("Unread research brief")
      .closest("a");
    if (!shortcut) {
      throw new Error("Unread research shortcut not found");
    }
    click(shortcut);

    await waitFor(() => {
      expect(pathname()).toBe("/chats/b0000000-0000-4000-a000-000000000901");
    });
  });

  it("hides current-agent unread chat shortcuts when the feature switch is off", async () => {
    mockConnectorCatalogStatus([]);
    mockUnreadShortcutThreads();

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/chat`,
      featureSwitches: {
        [FeatureSwitchKey.MobileUnreadChatThreadShortcuts]: false,
      },
    });

    await expect(
      screen.findByPlaceholderText(PLACEHOLDER),
    ).resolves.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Unread chats" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the last resolved suggested prompt catalog while a reload is pending", async () => {
    mockConnectorCatalogStatus([]);

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/chat`,
    });

    const promptGrid = await suggestedPromptGrid();
    expect(queryAllByRoleFast("button", promptGrid)).toHaveLength(1);

    const catalogRequested = context.mocks.deferred<void>();
    const catalogReady = context.mocks.deferred<void>();
    context.mocks.api(
      zeroConnectorCatalogContract.status,
      async ({ respond }) => {
        catalogRequested.resolve();
        await catalogReady.promise;
        return respond(200, {
          connectors: ["github", "sentry", "axiom", "plausible", "slack"].map(
            publicConnectorStatusItem,
          ),
        });
      },
    );
    context.store.set(reloadConnectors$);

    await catalogRequested.promise;
    expect(queryAllByRoleFast("button", promptGrid)).toHaveLength(1);

    catalogReady.resolve();
    await expect(
      screen.findByPlaceholderText(PLACEHOLDER),
    ).resolves.toBeInTheDocument();
  });

  it("does not treat pending catalog status as empty for suggested prompts", async () => {
    const catalogReady = context.mocks.deferred<void>();
    context.mocks.api(
      zeroConnectorCatalogContract.status,
      async ({ respond }) => {
        await catalogReady.promise;
        return respond(200, {
          connectors: [],
        });
      },
    );

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/chat`,
    });

    const promptGrid = await suggestedPromptGrid();
    const pendingButtons = queryAllByRoleFast("button", promptGrid);
    expect(pendingButtons).toHaveLength(3);

    catalogReady.resolve();
    await waitForElementToBeRemoved(pendingButtons.slice(0, 2));
    expect(queryAllByRoleFast("button", promptGrid)).toHaveLength(1);
  });

  it("fails closed when catalog status errors for suggested prompts", async () => {
    const catalogReady = context.mocks.deferred<void>();
    context.mocks.api(
      zeroConnectorCatalogContract.status,
      async ({ respond }) => {
        await catalogReady.promise;
        return respond(403, {
          error: { message: "Forbidden", code: "FORBIDDEN" },
        });
      },
    );

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/chat`,
    });

    const promptGrid = await suggestedPromptGrid();
    const pendingButtons = queryAllByRoleFast("button", promptGrid);
    expect(pendingButtons).toHaveLength(3);

    catalogReady.resolve();
    await waitForElementToBeRemoved(pendingButtons.slice(0, 2));
    expect(queryAllByRoleFast("button", promptGrid)).toHaveLength(1);
  });

  it("does not reuse stale catalog data after a suggested prompt catalog reload errors", async () => {
    mockConnectorCatalogStatus([
      "github",
      "sentry",
      "axiom",
      "plausible",
      "slack",
    ]);

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/chat`,
    });

    const promptGrid = await suggestedPromptGrid();
    await expect(
      screen.findByPlaceholderText(PLACEHOLDER),
    ).resolves.toBeInTheDocument();
    expect(queryAllByRoleFast("button", promptGrid)).toHaveLength(3);

    const catalogReady = context.mocks.deferred<void>();
    context.mocks.api(
      zeroConnectorCatalogContract.status,
      async ({ respond }) => {
        await catalogReady.promise;
        return respond(403, {
          error: { message: "Forbidden", code: "FORBIDDEN" },
        });
      },
    );
    context.store.set(reloadConnectors$);

    const loadingButtons = queryAllByRoleFast("button", promptGrid);
    expect(loadingButtons).toHaveLength(3);

    catalogReady.resolve();
    await waitForElementToBeRemoved(loadingButtons.slice(0, 2));
    expect(queryAllByRoleFast("button", promptGrid)).toHaveLength(1);
  });
});
