import { screen, waitFor } from "@testing-library/react";
import { WORKFLOW_TEMPLATE_ITEMS } from "@okouai/core/workflow-template-items";
import {
  integrationsSlackContract,
  type SlackOrgStatus,
} from "@okouai/api-contracts/contracts/integrations-slack";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { PLACEHOLDER } from "./chat-test-helpers.ts";

const context = testContext();

const SLACK_INSTALL_URL = "https://slack.com/oauth/v2/authorize?state=install";
const SLACK_CONNECT_URL = "https://slack.com/oauth/v2/authorize?state=connect";

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

const agentId = "c0000000-0000-4000-a000-000000000001";

// The row draws 3 of 6 kinds at random, so only the workflow card can carry a
// catalog title. Everything else comes from these localized entries.
const EN_TITLES = [
  "Create a presentation",
  "Build a website",
  "Create an illustration",
  "Create a video",
  "Create an avatar",
] as const;
const PT_BR_TITLES = [
  "Criar uma apresentação",
  "Criar um site",
  "Criar uma ilustração",
  "Criar um vídeo",
  "Criar um avatar",
] as const;
// The catalog's own English wording, which only en-US readers should see.
const EN_WORKFLOW_TITLES = WORKFLOW_TEMPLATE_ITEMS.map((item) => {
  return item.title;
});
const PT_BR_PLACEHOLDER =
  "Peça para automatizar fluxos de trabalho, gerenciar tarefas...";

function startCards(): readonly HTMLElement[] {
  return [
    ...screen.getByTestId("start-cards").querySelectorAll(".zero-card"),
  ].filter((element): element is HTMLElement => {
    return element instanceof HTMLElement;
  });
}

function templateButtons(): readonly HTMLElement[] {
  return queryAllByRoleFast("button", screen.getByTestId("start-cards")).filter(
    (element) => {
      return element.textContent?.trim() === "Templates";
    },
  );
}

function renderedTitles(titles: readonly string[]): readonly string[] {
  return titles.filter((title) => {
    return screen.queryByText(title) !== null;
  });
}

describe("chat start cards", () => {
  beforeEach(() => {
    vi.spyOn(window, "open").mockReturnValue(null);
  });

  it("draws three entry cards under the composer", async () => {
    detachedSetupPage({
      context,
      path: `/agents/${agentId}/chat`,
    });

    await expect(
      screen.findByPlaceholderText(PLACEHOLDER),
    ).resolves.toBeInTheDocument();

    expect(startCards()).toHaveLength(3);
    // At most one of the three kinds is the workflow card, so at least two
    // titles always come from the localized catalog.
    expect(renderedTitles(EN_TITLES).length).toBeGreaterThanOrEqual(2);
    expect(
      renderedTitles(EN_TITLES).length +
        renderedTitles(EN_WORKFLOW_TITLES).length,
    ).toBe(3);
    expect(screen.getAllByText("Create")).toHaveLength(3);
    expect(templateButtons()).toHaveLength(3);
  });

  it("writes the card prompt into the composer", async () => {
    detachedSetupPage({
      context,
      path: `/agents/${agentId}/chat`,
    });

    const composer = (await screen.findByPlaceholderText(
      PLACEHOLDER,
    )) as HTMLTextAreaElement;
    expect(composer).toHaveTextContent("");

    click(screen.getAllByText("Create")[0]);

    expect(composer.textContent).not.toBe("");
  });

  it("opens the template picker from a card", async () => {
    detachedSetupPage({
      context,
      path: `/agents/${agentId}/chat`,
    });

    await expect(
      screen.findByPlaceholderText(PLACEHOLDER),
    ).resolves.toBeInTheDocument();

    click(templateButtons()[0]);

    await expect(screen.findByRole("dialog")).resolves.toBeInTheDocument();
  });

  it("localizes the entry cards", async () => {
    context.mocks.data.userPreferences({
      locale: "pt-BR",
      supportedLocales: ["en-US", "pt-BR"],
    });
    context.mocks.data.onboardingStatus({ defaultAgentId: null });

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/chat`,
    });

    await expect(
      screen.findByPlaceholderText(PT_BR_PLACEHOLDER),
    ).resolves.toBeInTheDocument();

    expect(renderedTitles(PT_BR_TITLES).length).toBeGreaterThanOrEqual(2);
    expect(renderedTitles(EN_TITLES)).toStrictEqual([]);
    // The workflow card names a catalog template, which is localized too.
    expect(renderedTitles(EN_WORKFLOW_TITLES)).toStrictEqual([]);
    expect(screen.getAllByText("Modelos")).toHaveLength(3);
    expect(screen.queryByText("Templates")).toBeNull();
  });

  // The Slack card joins the same draw as the creation kinds rather than
  // being pinned, so which three land is random. What is deterministic is that
  // the row never grows a second line, and that the card leaves the pool for
  // good once there is nothing left to set up.
  it("keeps the row at three cards while the workspace still needs setup", async () => {
    mockSlackStatus({ isAdmin: true, installUrl: SLACK_INSTALL_URL });

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/chat`,
    });

    await expect(
      screen.findByPlaceholderText(PLACEHOLDER),
    ).resolves.toBeInTheDocument();

    await waitFor(() => {
      expect(startCards()).toHaveLength(3);
    });
    // Every drawn card carries exactly one of the two action pairs.
    expect(
      screen.queryAllByText("Create").length +
        screen.queryAllByText("How it works").length,
    ).toBe(3);
  });

  it("offers a personal connect step once the workspace is installed", async () => {
    mockSlackStatus({
      isInstalled: true,
      isAdmin: false,
      connectUrl: SLACK_CONNECT_URL,
    });

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/chat`,
    });

    await expect(
      screen.findByPlaceholderText(PLACEHOLDER),
    ).resolves.toBeInTheDocument();

    await waitFor(() => {
      expect(startCards()).toHaveLength(3);
    });
    expect(screen.queryByText("Add to Slack")).toBeNull();
  });

  it("drops Slack from the pool once the workspace is connected", async () => {
    mockSlackStatus({ isInstalled: true, isConnected: true });

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/chat`,
    });

    await expect(
      screen.findByPlaceholderText(PLACEHOLDER),
    ).resolves.toBeInTheDocument();

    expect(startCards()).toHaveLength(3);
    expect(screen.queryByText("Add Zero to Slack")).toBeNull();
    expect(screen.queryByText("How it works")).toBeNull();
    expect(screen.getAllByText("Create")).toHaveLength(3);
  });
});
