import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  agentInstructionsContract,
  agentsByIdContract,
  agentsMainContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import { parseAvatarComposerUrl } from "@okouai/core/agent-avatar";

const context = testContext();

function createDefaultAgent(): AgentResponse {
  return {
    agentId: "c0000000-0000-4000-a000-000000000001",
    ownerId: "test-user-123",
    displayName: "Zero",
    description: null,
    sound: null,
    avatarUrl: null,
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
    visibility: "public",
  };
}

function mockAgentsPage(agents: AgentResponse[]): void {
  context.mocks.data.agents(agents);
  context.mocks.api(agentsByIdContract.get, ({ params, respond }) => {
    const agent = agents.find((item) => {
      return item.agentId === params.id;
    });
    if (!agent) {
      return respond(404, {
        error: { message: "Not found", code: "NOT_FOUND" },
      });
    }
    return respond(200, {
      agentId: agent.agentId,
      ownerId: agent.ownerId,
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

function segmentByText(text: string): HTMLElement {
  const segment = queryAllByRoleFast("radio").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!segment) {
    throw new Error(`${text} segment not found`);
  }
  return segment;
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
    expect(segmentByText(tabName)).toBeInTheDocument();
  });
  click(segmentByText(tabName));
  await waitFor(() => {
    expect(segmentByText(tabName)).toHaveAttribute("aria-checked", "true");
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
      agentId,
      ownerId: "test-user-123",
      displayName: "Research Agent",
      description: "Finds launch risks",
      sound: "professional",
      avatarUrl: null,
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
      visibility: "public",
    },
  ]);
  context.mocks.data.userPreferences({ timezone: "UTC" });
  context.mocks.api(agentInstructionsContract.get, ({ respond }) => {
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
        agentId: "a0000000-0000-4000-a000-000000000101",
        ownerId: "test-user-123",
        displayName: "Research Agent",
        description: "Finds and summarizes information",
        sound: null,
        avatarUrl: null,
        modelProviderId: null,
        selectedModel: null,
        preferPersonalProvider: false,
        visibility: "public",
      },
      {
        agentId: "a0000000-0000-4000-a000-000000000102",
        ownerId: "test-user-123",
        displayName: null,
        description: "Writes content based on research",
        sound: null,
        avatarUrl: null,
        modelProviderId: null,
        selectedModel: null,
        preferPersonalProvider: false,
        visibility: "private",
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

    click(segmentByText("Private"));
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
    let agents: AgentResponse[] = [createDefaultAgent()];
    mockAgentsPage(agents);
    context.mocks.api(agentsMainContract.list, ({ respond }) => {
      return respond(200, agents);
    });
    context.mocks.api(agentsMainContract.create, ({ body, respond }) => {
      const agent: AgentResponse = {
        agentId:
          body.visibility === "private"
            ? "a0000000-0000-4000-a000-000000000202"
            : "a0000000-0000-4000-a000-000000000201",
        ownerId: "test-user-123",
        displayName: body.displayName ?? null,
        description: null,
        sound: body.sound ?? null,
        avatarUrl: body.avatarUrl ?? null,
        modelProviderId: null,
        selectedModel: null,
        preferPersonalProvider: false,
        visibility: body.visibility ?? "public",
      };
      agents = [...agents, agent];
      return respond(201, {
        agentId: agent.agentId,
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
      agentInstructionsContract.update,
      ({ params, respond }) => {
        const agent = agents.find((item) => {
          return item.agentId === params.id;
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
    expect(screen.getByText("Face")).toBeInTheDocument();
    click(screen.getByLabelText("Randomize avatar"));
    click(screen.getByLabelText("Next step"));
    await waitFor(() => {
      expect(screen.getByText("Hair")).toBeInTheDocument();
    });
    click(screen.getByLabelText("Next step"));
    click(screen.getByLabelText("Next step"));
    click(screen.getByLabelText("Next step"));
    await waitFor(() => {
      expect(screen.getByText("Color")).toBeInTheDocument();
    });
    click(screen.getByLabelText("Blue"));
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
    for (const agent of agents.slice(1)) {
      expect(parseAvatarComposerUrl(agent.avatarUrl)).not.toBeNull();
    }
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(dialog).not.toBeInTheDocument();

    click(segmentByText("Public"));
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
    let agents: AgentResponse[] = [
      createDefaultAgent(),
      {
        agentId: researchAgentId,
        ownerId: "test-user-123",
        displayName: "Research Agent",
        description: "Finds launch risks",
        sound: "professional",
        avatarUrl: null,
        modelProviderId: null,
        selectedModel: null,
        preferPersonalProvider: false,
        visibility: "public",
      },
    ];
    mockAgentsPage(agents);
    context.mocks.data.userPreferences({
      locale: "pt-BR",
      supportedLocales: ["en-US", "pt-BR"],
    });
    context.mocks.api(agentsMainContract.list, ({ respond }) => {
      return respond(200, agents);
    });
    context.mocks.api(agentsMainContract.create, ({ body, respond }) => {
      const agent: AgentResponse = {
        agentId: "a0000000-0000-4000-a000-000000000402",
        ownerId: "test-user-123",
        displayName: body.displayName ?? null,
        description: null,
        sound: body.sound ?? null,
        avatarUrl: body.avatarUrl ?? null,
        modelProviderId: null,
        selectedModel: null,
        preferPersonalProvider: false,
        visibility: body.visibility ?? "public",
      };
      agents = [...agents, agent];
      return respond(201, {
        agentId: agent.agentId,
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
      agentInstructionsContract.update,
      ({ params, respond }) => {
        const agent = agents.find((item) => {
          return item.agentId === params.id;
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
    context.mocks.api(agentInstructionsContract.get, ({ respond }) => {
      return respond(200, {
        content: "Summarize risks with concise bullets.",
        filename: "AGENTS.md",
      });
    });

    detachedSetupPage({
      context,
      path: "/agents",
    });

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
