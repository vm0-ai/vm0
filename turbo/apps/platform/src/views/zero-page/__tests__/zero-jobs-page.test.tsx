import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  zeroAgentInstructionsContract,
  zeroAgentsByIdContract,
  zeroAgentsMainContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import {
  type TeamComposeItem,
  zeroTeamContract,
} from "@vm0/api-contracts/contracts/zero-team";
import { i18n } from "../../../i18n/index.ts";
import { setLocale$ } from "../../../signals/locale.ts";

const context = testContext();

afterEach(async () => {
  await i18n.changeLanguage("en-US");
  document.documentElement.lang = "en-US";
});

function createDefaultAgent(): TeamComposeItem {
  return {
    id: "c0000000-0000-4000-a000-000000000001",
    ownerId: "test-user-123",
    displayName: "Zero",
    description: null,
    sound: null,
    avatarUrl: null,
    visibility: "public",
    headVersionId: "version_1",
    updatedAt: "2024-01-01T00:00:00Z",
  };
}

function mockAgentsPage(team: TeamComposeItem[]): void {
  context.mocks.data.team(team);
  context.mocks.api(zeroAgentsByIdContract.get, ({ params, respond }) => {
    const agent = team.find((item) => {
      return item.id === params.id;
    });
    if (!agent) {
      return respond(404, {
        error: { message: "Not found", code: "NOT_FOUND" },
      });
    }
    return respond(200, {
      agentId: agent.id,
      ownerId: agent.ownerId ?? "test-user-123",
      description: agent.description,
      displayName: agent.displayName,
      sound: agent.sound,
      avatarUrl: agent.avatarUrl,
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
      visibility: agent.visibility,
    });
  });
}

function tabByText(text: string): HTMLElement {
  const tab = queryAllByRoleFast("tab").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!tab) {
    throw new Error(`${text} tab not found`);
  }
  return tab;
}

function newAgentButton(label = "New agent"): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === label;
  });
  if (!button) {
    throw new Error(`${label} button not found`);
  }
  return button;
}

async function openCreateDialog(
  tabName: "Public" | "Private",
): Promise<HTMLElement> {
  await waitFor(() => {
    expect(tabByText(tabName)).toBeInTheDocument();
  });
  click(tabByText(tabName));
  await waitFor(() => {
    expect(tabByText(tabName)).toHaveAttribute("aria-selected", "true");
  });
  click(newAgentButton());
  return await screen.findByRole("dialog");
}

function dialogCreateButton(
  dialog: HTMLElement,
  label = "Create",
): HTMLElement {
  const createButton = queryAllByRoleFast("button", dialog).find((button) => {
    return button.textContent?.trim() === label;
  });
  if (!createButton) {
    throw new Error("dialog create button not found");
  }
  return createButton;
}

function dialogCloseButton(dialog: HTMLElement, label: string): HTMLElement {
  const closeButton = queryAllByRoleFast("button", dialog).find((button) => {
    return button.getAttribute("aria-label") === label;
  });
  if (!closeButton) {
    throw new Error("dialog close button not found");
  }
  return closeButton;
}

function mockAgentDetailStory(): string {
  const agentId = "a0000000-0000-4000-a000-000000000301";
  mockAgentsPage([
    createDefaultAgent(),
    {
      id: agentId,
      ownerId: "test-user-123",
      displayName: "Research Agent",
      description: "Finds launch risks",
      sound: "professional",
      avatarUrl: null,
      visibility: "public",
      headVersionId: "version_4",
      updatedAt: "2026-03-10T00:00:00Z",
    },
  ]);
  context.mocks.data.userPreferences({ timezone: "UTC" });
  context.mocks.api(zeroAgentInstructionsContract.get, ({ respond }) => {
    return respond(200, {
      content: "Summarize risks with concise bullets.",
      filename: "AGENTS.md",
    });
  });
  return agentId;
}

describe("zero jobs page", () => {
  it("shows agents and create actions across the management surfaces", async () => {
    mockAgentsPage([
      createDefaultAgent(),
      {
        id: "a0000000-0000-4000-a000-000000000101",
        ownerId: "test-user-123",
        displayName: "Research Agent",
        description: "Finds and summarizes information",
        sound: null,
        avatarUrl: null,
        visibility: "public",
        headVersionId: "version_2",
        updatedAt: "2024-01-02T00:00:00Z",
      },
      {
        id: "a0000000-0000-4000-a000-000000000102",
        ownerId: "test-user-123",
        displayName: null,
        description: "Writes content based on research",
        sound: null,
        avatarUrl: null,
        visibility: "private",
        headVersionId: "version_3",
        updatedAt: "2024-01-03T00:00:00Z",
      },
    ]);
    detachedSetupPage({
      context,
      path: "/agents",
    });

    await waitFor(() => {
      expect(screen.getByText("Research Agent")).toBeInTheDocument();
      expect(
        screen.getByText("Finds and summarizes information"),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText("Writes content based on research")).toBeNull();
    expect(newAgentButton()).toBeInTheDocument();

    click(tabByText("Private"));
    await waitFor(() => {
      expect(
        screen.getByText("a0000000-0000-4000-a000-000000000102"),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Writes content based on research"),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText("Finds and summarizes information")).toBeNull();
    expect(newAgentButton()).toBeInTheDocument();
  });

  it("creates public and private agents, customizes avatars, supports Enter submit, cancel, and card navigation", async () => {
    let team: TeamComposeItem[] = [createDefaultAgent()];
    mockAgentsPage(team);
    context.mocks.api(zeroTeamContract.list, ({ respond }) => {
      return respond(200, team);
    });
    context.mocks.api(zeroAgentsMainContract.create, ({ body, respond }) => {
      const agent: TeamComposeItem = {
        id:
          body.visibility === "private"
            ? "a0000000-0000-4000-a000-000000000202"
            : "a0000000-0000-4000-a000-000000000201",
        ownerId: "test-user-123",
        displayName: body.displayName ?? null,
        description: null,
        sound: body.sound ?? null,
        avatarUrl: body.avatarUrl ?? null,
        visibility: body.visibility ?? "public",
        headVersionId: "version_created",
        updatedAt: "2026-03-10T00:00:00Z",
      };
      team = [...team, agent];
      return respond(201, {
        agentId: agent.id,
        ownerId: "test-user-123",
        description: null,
        displayName: agent.displayName,
        sound: agent.sound,
        avatarUrl: agent.avatarUrl,
        modelProviderId: null,
        selectedModel: null,
        preferPersonalProvider: false,
        visibility: agent.visibility,
      });
    });
    context.mocks.api(
      zeroAgentInstructionsContract.update,
      ({ params, respond }) => {
        const agent = team.find((item) => {
          return item.id === params.id;
        });
        return respond(200, {
          agentId: params.id,
          ownerId: "test-user-123",
          description: null,
          displayName: agent?.displayName ?? null,
          sound: agent?.sound ?? null,
          avatarUrl: agent?.avatarUrl ?? null,
          modelProviderId: null,
          selectedModel: null,
          preferPersonalProvider: false,
          visibility: agent?.visibility ?? "public",
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/agents",
    });

    let dialog = await openCreateDialog("Public");
    await fill(
      screen.getByPlaceholderText("e.g. Research Assistant"),
      "Marketing Bot",
    );
    click(screen.getByLabelText("Customize avatar"));
    const avatarDialog = await screen.findByRole("dialog", {
      name: "Give your agent a face",
    });
    expect(screen.getByText("Angle")).toBeInTheDocument();
    click(screen.getByLabelText("Randomize avatar"));
    click(screen.getByLabelText("Next step"));
    await waitFor(() => {
      expect(screen.getByText("Skin")).toBeInTheDocument();
    });
    click(screen.getByLabelText("Next step"));
    click(screen.getByLabelText("Next step"));
    click(screen.getByLabelText("Next step"));
    click(screen.getByLabelText("Next step"));
    await waitFor(() => {
      expect(screen.getByText("Mood")).toBeInTheDocument();
      expect(screen.getByText("Chill")).toBeInTheDocument();
      expect(screen.getByText("Normal")).toBeInTheDocument();
      expect(screen.getByText("Hyped")).toBeInTheDocument();
    });
    click(screen.getByText("Chill"));
    click(screen.getByText("Use this avatar"));
    await waitFor(() => {
      expect(avatarDialog).not.toBeInTheDocument();
      expect(
        screen.getByRole("img", { name: "New agent" }),
      ).toBeInTheDocument();
    });
    click(dialogCreateButton(dialog));

    await waitFor(() => {
      expect(screen.getByText("Marketing Bot")).toBeInTheDocument();
      expect(
        screen.getByRole("img", { name: "Marketing Bot" }),
      ).toBeInTheDocument();
    });

    dialog = await openCreateDialog("Private");
    expect(
      within(dialog).getByRole("heading", { name: "Create a new agent" }),
    ).toBeInTheDocument();
    click(screen.getByText("Cancel"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    dialog = await openCreateDialog("Private");
    const privateAgentInput = screen.getByPlaceholderText(
      "e.g. Research Assistant",
    );
    await fill(privateAgentInput, "Private Analyst");
    fireEvent.keyDown(privateAgentInput, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByText("Private Analyst")).toBeInTheDocument();
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(dialog).not.toBeInTheDocument();

    click(tabByText("Public"));
    await waitFor(() => {
      expect(screen.getByText("Marketing Bot")).toBeInTheDocument();
    });

    const marketingBotLink = queryAllByRoleFast("link").find((link) => {
      return (
        link.getAttribute("href") ===
        "/agents/a0000000-0000-4000-a000-000000000201"
      );
    });
    if (!marketingBotLink) {
      throw new Error("Marketing Bot detail link not found");
    }
    click(marketingBotLink);

    await waitFor(() => {
      expect(document.title).toContain("Marketing Bot");
    });
  });

  it("navigates the Profile and Instructions agent detail tabs", async () => {
    const agentId = mockAgentDetailStory();

    detachedSetupPage({ context, path: `/agents/${agentId}` });

    await waitFor(() => {
      expect(
        screen.getByLabelText("Chat with Research Agent"),
      ).toBeInTheDocument();
    });

    click(tabByText("Profile"));
    await waitFor(() => {
      expect(screen.getByDisplayValue("Research Agent")).toBeInTheDocument();
      expect(
        screen.getByDisplayValue("Finds launch risks"),
      ).toBeInTheDocument();
    });

    click(tabByText("Instructions"));
    await waitFor(() => {
      expect(
        screen.getByText("Summarize risks with concise bullets."),
      ).toBeInTheDocument();
    });
  });

  it("localizes agent listing, creation, and management in Brazilian Portuguese", async () => {
    const researchAgentId = "a0000000-0000-4000-a000-000000000401";
    let team: TeamComposeItem[] = [
      createDefaultAgent(),
      {
        id: researchAgentId,
        ownerId: "test-user-123",
        displayName: "Research Agent",
        description: "Finds launch risks",
        sound: "professional",
        avatarUrl: null,
        visibility: "public",
        headVersionId: "version_pt",
        updatedAt: "2026-03-10T00:00:00Z",
      },
    ];
    mockAgentsPage(team);
    context.mocks.data.userPreferences({
      locale: "pt-BR",
      supportedLocales: ["en-US", "pt-BR"],
    });
    await context.store.set(setLocale$, "pt-BR", context.signal);
    context.mocks.api(zeroTeamContract.list, ({ respond }) => {
      return respond(200, team);
    });
    context.mocks.api(zeroAgentsMainContract.create, ({ body, respond }) => {
      const agent: TeamComposeItem = {
        id: "a0000000-0000-4000-a000-000000000402",
        ownerId: "test-user-123",
        displayName: body.displayName ?? null,
        description: null,
        sound: body.sound ?? null,
        avatarUrl: body.avatarUrl ?? null,
        visibility: body.visibility ?? "public",
        headVersionId: "version_created_pt",
        updatedAt: "2026-03-10T00:00:00Z",
      };
      team = [...team, agent];
      return respond(201, {
        agentId: agent.id,
        ownerId: "test-user-123",
        description: agent.description,
        displayName: agent.displayName,
        sound: agent.sound,
        avatarUrl: agent.avatarUrl,
        modelProviderId: null,
        selectedModel: null,
        preferPersonalProvider: false,
        visibility: agent.visibility,
      });
    });
    context.mocks.api(
      zeroAgentInstructionsContract.update,
      ({ params, respond }) => {
        const agent = team.find((item) => {
          return item.id === params.id;
        });
        return respond(200, {
          agentId: params.id,
          ownerId: "test-user-123",
          description: agent?.description ?? null,
          displayName: agent?.displayName ?? null,
          sound: agent?.sound ?? null,
          avatarUrl: agent?.avatarUrl ?? null,
          modelProviderId: null,
          selectedModel: null,
          preferPersonalProvider: false,
          visibility: agent?.visibility ?? "public",
        });
      },
    );
    context.mocks.api(zeroAgentInstructionsContract.get, ({ respond }) => {
      return respond(200, {
        content: "Summarize risks with concise bullets.",
        filename: "AGENTS.md",
      });
    });

    detachedSetupPage({ context, path: "/agents" });

    await expect(
      screen.findByRole("heading", { name: "Agentes" }),
    ).resolves.toBeInTheDocument();
    expect(screen.getByText("Research Agent")).toBeInTheDocument();
    expect(screen.getByText("Finds launch risks")).toBeInTheDocument();

    click(newAgentButton("Novo agente"));
    const createDialog = await screen.findByRole("dialog", {
      name: "Criar um novo agente",
    });
    expect(dialogCloseButton(createDialog, "Fechar")).toBeInTheDocument();
    await fill(
      within(createDialog).getByPlaceholderText("Ex.: Assistente de pesquisa"),
      "Agente de marketing",
    );
    click(dialogCreateButton(createDialog, "Criar"));

    await expect(
      screen.findByText("Agente de marketing"),
    ).resolves.toBeInTheDocument();

    const researchAgentLink = screen.getByText("Research Agent").closest("a");
    if (!(researchAgentLink instanceof HTMLElement)) {
      throw new Error("Research Agent link not found");
    }
    click(researchAgentLink);

    await expect(
      screen.findByLabelText("Conversar com Research Agent"),
    ).resolves.toBeInTheDocument();
    expect(tabByText("Autorização")).toBeInTheDocument();
    click(tabByText("Perfil"));
    await expect(
      screen.findByDisplayValue("Finds launch risks"),
    ).resolves.toBeInTheDocument();
    expect(screen.getByText("Nome")).toBeInTheDocument();

    click(screen.getByText("Excluir agente"));
    const deleteDialog = await screen.findByRole("dialog", {
      name: "Excluir Research Agent?",
    });
    expect(dialogCloseButton(deleteDialog, "Fechar")).toBeInTheDocument();
  });
});
