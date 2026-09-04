import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  agentInstructionsContract,
  agentsByIdContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import {
  AVATAR_PRESET_COUNT,
  DEFAULT_AGENT_AVATAR_URL,
} from "@okouai/core/agent-avatar";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedNavigateTo$ } from "../../../signals/route.ts";
import { ROUTES } from "../../../signals/route-paths.ts";

const context = testContext();

const AGENT_ID = "a0000000-0000-4000-a000-000000000020";
const SECOND_AGENT_ID = "a0000000-0000-4000-a000-000000000021";
const PAGE_LOAD_TIMEOUT_MS = 5000;

function renderedAvatarSvgLayerSrcs(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll<HTMLImageElement>("img"), (img) => {
    return img.src;
  }).filter((src) => {
    return src.includes("/platform/views/zero-page/assets/avatar-svg");
  });
}

function findCreateCustomAvatarButton(): Promise<HTMLElement> {
  return screen.findByLabelText("Create custom avatar", undefined, {
    timeout: PAGE_LOAD_TIMEOUT_MS,
  });
}

function findAgentNameInput(): Promise<HTMLElement> {
  return screen.findByDisplayValue("Research Agent", undefined, {
    timeout: PAGE_LOAD_TIMEOUT_MS,
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

function prepareAgentProfile(
  avatarUrl = "preset:0",
  displayName = "Research Agent",
): void {
  let detail: AgentResponse = {
    agentId: AGENT_ID,
    ownerId: "test-user-123",
    description: "A helpful agent",
    displayName,
    sound: "professional",
    avatarUrl,
    visibility: "public",
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
  };

  context.mocks.data.agents([
    {
      agentId: "c0000000-0000-4000-a000-000000000001",
      ownerId: "test-user-123",
      displayName: "Zero",
      description: null,
      sound: null,
      avatarUrl: null,
      visibility: "public",
    },
    {
      agentId: AGENT_ID,
      ownerId: "test-user-123",
      displayName,
      description: detail.description,
      sound: detail.sound,
      avatarUrl: detail.avatarUrl,
      visibility: "public",
    },
  ]);
  context.mocks.api(agentsByIdContract.get, ({ respond }) => {
    return respond(200, detail);
  });
  context.mocks.api(agentsByIdContract.updateMetadata, ({ body, respond }) => {
    detail = { ...detail, ...body };
    return respond(200, detail);
  });
  context.mocks.api(agentInstructionsContract.get, ({ respond }) => {
    return respond(200, { content: null, filename: null });
  });
}

function prepareMatchingAgentProfiles(): void {
  const details: Record<string, AgentResponse> = {
    [AGENT_ID]: {
      agentId: AGENT_ID,
      ownerId: "test-user-123",
      description: "A shared description",
      displayName: "Shared Agent",
      sound: "professional",
      avatarUrl: "preset:0",
      visibility: "public",
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
    },
    [SECOND_AGENT_ID]: {
      agentId: SECOND_AGENT_ID,
      ownerId: "test-user-123",
      description: "A shared description",
      displayName: "Shared Agent",
      sound: "professional",
      avatarUrl: "preset:0",
      visibility: "public",
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
    },
  };

  context.mocks.data.agents([
    {
      agentId: AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Shared Agent",
      description: "A shared description",
      sound: "professional",
      avatarUrl: "preset:0",
      visibility: "public",
    },
    {
      agentId: SECOND_AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Shared Agent",
      description: "A shared description",
      sound: "professional",
      avatarUrl: "preset:0",
      visibility: "public",
    },
  ]);
  context.mocks.api(agentsByIdContract.get, ({ params, respond }) => {
    const detail = details[params.id];
    if (!detail) {
      throw new Error(`Unexpected agent detail request: ${params.id}`);
    }
    return respond(200, detail);
  });
  context.mocks.api(agentInstructionsContract.get, ({ respond }) => {
    return respond(200, { content: null, filename: null });
  });
}

describe("zero settings tab", () => {
  it("renders the default agent avatar without customization controls", async () => {
    context.mocks.data.onboardingStatus({ defaultAgentId: AGENT_ID });
    prepareAgentProfile(DEFAULT_AGENT_AVATAR_URL);
    detachedSetupPage({ context, path: `/agents/${AGENT_ID}?tab=profile` });

    const avatarLabel = await screen.findByText("Avatar", { selector: "p" });
    const avatarRow = avatarLabel.parentElement?.parentElement;
    if (!avatarRow) {
      throw new Error("Avatar profile row not found");
    }
    const avatarImages = avatarRow.querySelectorAll<HTMLImageElement>("img");

    expect(avatarImages).toHaveLength(1);
    expect(avatarImages[0]).toHaveAttribute("src", DEFAULT_AGENT_AVATAR_URL);
    expect(screen.queryByLabelText("Create custom avatar")).toBeNull();
    expect(screen.queryByLabelText("Customize avatar")).toBeNull();
  });

  it("renders the default agent name as text without an input", async () => {
    context.mocks.data.onboardingStatus({ defaultAgentId: AGENT_ID });
    prepareAgentProfile("preset:0", "Renamed default agent");
    detachedSetupPage({ context, path: `/agents/${AGENT_ID}?tab=profile` });

    const nameLabel = await screen.findByText("Name", { selector: "p" });
    const nameRow = nameLabel.parentElement?.parentElement;
    if (!nameRow) {
      throw new Error("Name profile row not found");
    }

    expect(nameRow).toHaveTextContent("Okou");
    expect(nameRow.querySelector("input")).toBeNull();
  });

  it("keeps rendering the highest legacy preset", async () => {
    prepareAgentProfile(`preset:${AVATAR_PRESET_COUNT - 1}`);
    detachedSetupPage({ context, path: `/agents/${AGENT_ID}?tab=profile` });

    await findAgentNameInput();
    const avatarLabel = await screen.findByText("Avatar", { selector: "p" });
    const avatarRow = avatarLabel.parentElement?.parentElement;
    if (!avatarRow) {
      throw new Error("Avatar profile row not found");
    }

    expect(renderedAvatarSvgLayerSrcs(avatarRow)).toStrictEqual([
      expect.stringContaining("/head-r5-s4.svg"),
      expect.stringContaining("/face-r5-f5-m.svg"),
      expect.stringContaining("/hair-r5-h2-c2.svg"),
    ]);
  });

  it("keeps rendering a legacy custom SVG avatar", async () => {
    prepareAgentProfile("svg:r3s2h4c1f5h");
    detachedSetupPage({ context, path: `/agents/${AGENT_ID}?tab=profile` });

    await findAgentNameInput();
    const avatarLabel = await screen.findByText("Avatar", { selector: "p" });
    const avatarRow = avatarLabel.parentElement?.parentElement;
    if (!avatarRow) {
      throw new Error("Avatar profile row not found");
    }

    expect(renderedAvatarSvgLayerSrcs(avatarRow)).toStrictEqual([
      expect.stringContaining("/head-r3-s2.svg"),
      expect.stringContaining("/face-r3-f5-h.svg"),
      expect.stringContaining("/hair-r3-h4-c1.svg"),
    ]);
  });

  it("loads only the visible avatar SVG layers", async () => {
    prepareAgentProfile();
    detachedSetupPage({ context, path: `/agents/${AGENT_ID}?tab=profile` });

    click(await findCreateCustomAvatarButton());

    const dialog = await screen.findByRole("dialog");
    const layerSrcs = renderedAvatarSvgLayerSrcs(dialog);

    expect(layerSrcs).toHaveLength(28);
    const uniqueSrcs = new Set(layerSrcs);
    expect(uniqueSrcs.size).toBe(24);
  });

  it("keeps the avatar option tray stable with tightly packed rows", async () => {
    prepareAgentProfile();
    detachedSetupPage({ context, path: `/agents/${AGENT_ID}?tab=profile` });

    click(await findCreateCustomAvatarButton());

    const faceOption = await screen.findByLabelText("Round");
    const optionGrid = faceOption.parentElement;
    const optionTray = optionGrid?.parentElement;
    if (!optionGrid || !optionTray) {
      throw new Error("Avatar option tray not found");
    }
    expect(optionTray).toHaveClass("h-48");
    expect(optionGrid).toHaveClass("min-h-full", "content-center", "gap-3");

    for (const optionLabel of ["High bun", "Neutral smile", "Gold", "Blue"]) {
      click(screen.getByLabelText("Next step"));
      const option = await screen.findByLabelText(optionLabel);
      expect(option.parentElement).toBe(optionGrid);
      expect(optionTray).toHaveClass("h-48");
    }
  });

  it("creates and saves a custom avatar from the profile page", async () => {
    prepareAgentProfile();

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}?tab=profile` });

    click(await findCreateCustomAvatarButton());

    await waitFor(() => {
      expect(
        screen.getAllByText("Give your agent a face").length,
      ).toBeGreaterThan(0);
      expect(screen.getByText("Face")).toBeInTheDocument();
    });

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
      expect(screen.queryAllByText("Give your agent a face")).toHaveLength(0);
      expect(screen.getByText("Profile saved")).toBeInTheDocument();
    });

    const avatarLabel = await screen.findByText("Avatar", { selector: "p" });
    const avatarRow = avatarLabel.parentElement?.parentElement;
    if (!avatarRow) {
      throw new Error("Avatar profile row not found");
    }
    const newAvatarLayers = renderedAvatarSvgLayerSrcs(avatarRow);
    expect(newAvatarLayers).toHaveLength(4);
    expect(newAvatarLayers).toStrictEqual([
      expect.stringMatching(/\/avatar-svg-v2\/.*\/hairs\/.*-blue-rear\.svg$/u),
      expect.stringMatching(/\/avatar-svg-v2\/.*\/faces\//u),
      expect.stringMatching(/\/avatar-svg-v2\/.*\/hairs\/.*-blue-front\.svg$/u),
      expect.stringMatching(/\/avatar-svg-v2\/.*\/expressions\//u),
    ]);

    click(screen.getByLabelText("Create custom avatar"));

    await waitFor(() => {
      expect(
        screen.getAllByText("Give your agent a face").length,
      ).toBeGreaterThan(0);
    });

    click(screen.getByText("Cancel"));

    await waitFor(() => {
      expect(screen.queryAllByText("Give your agent a face")).toHaveLength(0);
    });
  });

  it("keeps profile drafts within the active agent", async () => {
    prepareMatchingAgentProfiles();

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}?tab=profile` });

    await fill(
      await screen.findByDisplayValue("Shared Agent", undefined, {
        timeout: PAGE_LOAD_TIMEOUT_MS,
      }),
      "Unsaved Agent",
    );

    click(tabByText("Instructions"));
    await waitFor(() => {
      expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    });
    click(tabByText("Profile"));

    await waitFor(() => {
      expect(screen.getByDisplayValue("Unsaved Agent")).toBeInTheDocument();
      expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
    });

    context.store.set(detachedNavigateTo$, ROUTES.agentDetail, {
      pathParams: { agentId: SECOND_AGENT_ID },
      searchParams: new URLSearchParams("tab=profile"),
    });

    await waitFor(() => {
      expect(screen.getByDisplayValue("Shared Agent")).toBeInTheDocument();
      expect(
        screen.queryByText("You have unsaved changes"),
      ).not.toBeInTheDocument();
    });

    context.store.set(detachedNavigateTo$, ROUTES.agentDetail, {
      pathParams: { agentId: AGENT_ID },
      searchParams: new URLSearchParams("tab=profile"),
    });

    await waitFor(() => {
      expect(screen.getByDisplayValue("Shared Agent")).toBeInTheDocument();
      expect(
        screen.queryByText("You have unsaved changes"),
      ).not.toBeInTheDocument();
    });
  });

  it("saves, discards, and confirms visible agent profile edits", async () => {
    prepareAgentProfile();

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}?tab=profile` });

    const nameInput = await findAgentNameInput();
    await fill(nameInput, "Research Lead");
    await fill(
      screen.getByLabelText("Description"),
      "Helps with release research",
    );
    click(screen.getByText("Friendly"));
    click(screen.getByLabelText("Make public"));

    await waitFor(() => {
      expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
      expect(screen.getByText("Warm and approachable")).toBeInTheDocument();
      expect(screen.getByLabelText("Make public")).toHaveAttribute(
        "aria-checked",
        "false",
      );
    });

    click(screen.getByText("Save"));

    // Demoting the agent from public to private now requires confirmation.
    await waitFor(() => {
      expect(
        screen.getByText("Make Research Agent private?"),
      ).toBeInTheDocument();
    });
    click(screen.getByText("Make private"));

    await waitFor(() => {
      expect(
        screen.queryByText("You have unsaved changes"),
      ).not.toBeInTheDocument();
      expect(screen.getByDisplayValue("Research Lead")).toBeInTheDocument();
      expect(
        screen.getByDisplayValue("Helps with release research"),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Make public")).toHaveAttribute(
        "aria-checked",
        "false",
      );
    });

    await fill(screen.getByDisplayValue("Research Lead"), "Temporary Name");

    await waitFor(() => {
      expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
    });

    click(screen.getByText("Discard"));

    await waitFor(() => {
      expect(
        screen.queryByText("You have unsaved changes"),
      ).not.toBeInTheDocument();
      expect(screen.getByDisplayValue("Research Lead")).toBeInTheDocument();
    });

    click(screen.getByText("Delete agent"));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(
        screen.getByText(
          /Deletes the agent, its workflows, automations, and everyone.s chat history/u,
        ),
      ).toBeInTheDocument();
    });

    click(screen.getByText("Cancel"));

    await waitFor(() => {
      expect(
        screen.queryByText(
          /Deletes the agent, its workflows, automations, and everyone.s chat history/u,
        ),
      ).not.toBeInTheDocument();
    });
  });
});
