import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  agentInstructionsContract,
  agentsByIdContract,
  type AgentMetadataRequest,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import {
  AVATAR_PRESET_COUNT,
  DEFAULT_AGENT_AVATAR_URL,
} from "@okouai/core/agent-avatar";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import {
  click,
  setupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const AGENT_ID = "a0000000-0000-4000-a000-000000000020";

function renderedAvatarSvgLayerSrcs(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll<HTMLImageElement>("img"), (img) => {
    return img.src;
  }).filter((src) => {
    return src.includes("/platform/views/zero-page/assets/avatar-svg");
  });
}

function findCreateCustomAvatarButton(): Promise<HTMLElement> {
  return screen.findByLabelText("Create custom avatar");
}

function findAgentNameInput(): Promise<HTMLElement> {
  return screen.findByDisplayValue("Research Agent");
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
  ownerId = "test-user-123",
): {
  readonly lastUpdate: () => AgentMetadataRequest | null;
  readonly lastSavedProfile: () => AgentResponse | null;
} {
  let lastUpdate: AgentMetadataRequest | null = null;
  let lastSavedProfile: AgentResponse | null = null;
  let detail: AgentResponse = {
    agentId: AGENT_ID,
    ownerId,
    description: "A helpful agent",
    displayName: "Research Agent",
    sound: "professional",
    avatarUrl,
    visibility: "public",
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
  };

  context.mocks.data.agents([
    {
      agentId: DEFAULT_AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Zero",
      description: null,
      sound: null,
      avatarUrl: null,
      visibility: "public",
    },
    {
      agentId: AGENT_ID,
      ownerId,
      displayName: detail.displayName,
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
    lastUpdate = body;
    detail = { ...detail, ...body };
    lastSavedProfile = detail;
    return respond(200, detail);
  });
  context.mocks.api(agentInstructionsContract.get, ({ respond }) => {
    return respond(200, { content: null, filename: null });
  });
  return {
    lastUpdate: () => {
      return lastUpdate;
    },
    lastSavedProfile: () => {
      return lastSavedProfile;
    },
  };
}

test("Keep rendering the highest legacy avatar preset", async () => {
  prepareAgentProfile(`preset:${AVATAR_PRESET_COUNT - 1}`);
  await setupPage({ context, path: `/agents/${AGENT_ID}?tab=profile` });

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

test("Keep rendering a legacy custom SVG avatar", async () => {
  prepareAgentProfile("svg:r3s2h4c1f5h");
  await setupPage({ context, path: `/agents/${AGENT_ID}?tab=profile` });

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

test("Load only the visible avatar SVG layers", async () => {
  prepareAgentProfile();
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}?tab=profile`,
    featureSwitches: { [FeatureSwitchKey.AvatarComposerV2]: true },
  });

  click(await findCreateCustomAvatarButton());

  const dialog = await screen.findByRole("dialog", {
    name: "Give your agent a face",
  });
  const layerSrcs = renderedAvatarSvgLayerSrcs(dialog);

  // Six layers each — four for the head, plus the neck under it and the
  // sweater over it — across the preview and the six face options. The shared
  // neck and sweater are one request each no matter how many avatars use them.
  expect(layerSrcs).toHaveLength(42);
  expect(new Set(layerSrcs).size).toBe(26);
});

test("Keep every composer step and its edge options usable in one dialog", async () => {
  prepareAgentProfile();
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}?tab=profile`,
    featureSwitches: { [FeatureSwitchKey.AvatarComposerV2]: true },
  });

  click(await findCreateCustomAvatarButton());

  const dialog = await screen.findByRole("dialog", {
    name: "Give your agent a face",
  });
  const steps = [
    { label: "Face", first: "Round", last: "Oval" },
    { label: "Hair", first: "High bun", last: "Ribbon updo" },
    { label: "Mood", first: "Neutral smile", last: "Stubble smile" },
    { label: "Skin", first: "Gold", last: "Brown" },
    { label: "Color", first: "Blue", last: "Brown" },
    { label: "Sweater", first: "Lime", last: "Orange" },
  ] as const;

  for (const [index, step] of steps.entries()) {
    expect(dialog).toBeVisible();
    expect(within(dialog).getByText(step.label)).toBeVisible();
    expect(within(dialog).getByLabelText(step.first)).toBeVisible();
    expect(within(dialog).getByLabelText(step.last)).toBeVisible();
    expect(within(dialog).getByText("Use this avatar")).toBeVisible();
    if (index + 1 < steps.length) {
      click(within(dialog).getByLabelText("Next step"));
    }
  }
});

test("Keep the legacy avatar editor available when its switch is disabled", async () => {
  prepareAgentProfile();
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}?tab=profile`,
    featureSwitches: { [FeatureSwitchKey.AvatarComposerV2]: false },
  });

  click(await findCreateCustomAvatarButton());

  const dialog = await screen.findByRole("dialog", {
    name: "Give your agent a face",
  });
  expect(within(dialog).getByText("Angle")).toBeVisible();
  expect(within(dialog).getByLabelText("Angle 1")).toBeVisible();
  expect(within(dialog).queryByLabelText("Round")).not.toBeInTheDocument();
  click(within(dialog).getByLabelText("Randomize avatar"));
  click(within(dialog).getByText("Use this avatar"));

  await waitFor(() => {
    expect(screen.getByText("Profile saved")).toBeInTheDocument();
  });
  const avatarLabel = await screen.findByText("Avatar", { selector: "p" });
  const avatarRow = avatarLabel.parentElement?.parentElement;
  if (!avatarRow) {
    throw new Error("Avatar profile row not found");
  }
  expect(renderedAvatarSvgLayerSrcs(avatarRow)).toHaveLength(3);
});

test("Create and save a composer avatar from the profile page", async () => {
  prepareAgentProfile();
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}?tab=profile`,
    featureSwitches: { [FeatureSwitchKey.AvatarComposerV2]: true },
  });

  click(await findCreateCustomAvatarButton());

  const dialog = await screen.findByRole("dialog", {
    name: "Give your agent a face",
  });
  expect(within(dialog).getByText("Face")).toBeVisible();
  click(within(dialog).getByLabelText("Randomize avatar"));
  for (const step of ["Hair", "Mood", "Skin", "Color"]) {
    click(within(dialog).getByLabelText("Next step"));
    await expect(within(dialog).findByText(step)).resolves.toBeVisible();
  }
  click(within(dialog).getByLabelText("Blue"));
  await expect(within(dialog).findByText("Sweater")).resolves.toBeVisible();
  click(within(dialog).getByLabelText("Pink"));
  click(within(dialog).getByText("Use this avatar"));

  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
    expect(screen.getByText("Profile saved")).toBeInTheDocument();
  });

  const avatarLabel = await screen.findByText("Avatar", { selector: "p" });
  const avatarRow = avatarLabel.parentElement?.parentElement;
  if (!avatarRow) {
    throw new Error("Avatar profile row not found");
  }
  expect(renderedAvatarSvgLayerSrcs(avatarRow)).toStrictEqual([
    expect.stringMatching(/\/avatar-svg-v2\/.*\/neck\//u),
    expect.stringMatching(/\/avatar-svg-v2\/.*\/hairs\/.*-blue-rear\.svg$/u),
    expect.stringMatching(/\/avatar-svg-v2\/.*\/faces\//u),
    expect.stringMatching(/\/avatar-svg-v2\/.*\/hairs\/.*-blue-front\.svg$/u),
    expect.stringMatching(/\/avatar-svg-v2\/.*\/expressions\//u),
    expect.stringMatching(/\/avatar-svg-v2\/.*\/sweater\/pink\.svg$/u),
  ]);
});

test("Allow an org admin to update another user's public agent avatar", async () => {
  const profile = prepareAgentProfile("preset:0", "agent-owner");
  context.mocks.data.org({
    id: "org_default",
    name: "Default Org",
    role: "admin",
  });
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}?tab=profile`,
    featureSwitches: { [FeatureSwitchKey.AvatarComposerV2]: true },
  });

  click(await findCreateCustomAvatarButton());

  const dialog = await screen.findByRole("dialog", {
    name: "Give your agent a face",
  });
  click(within(dialog).getByLabelText("Randomize avatar"));
  click(within(dialog).getByText("Use this avatar"));

  await waitFor(() => {
    expect(profile.lastSavedProfile()).not.toBeNull();
  });
  const savedProfile = profile.lastSavedProfile();
  if (!savedProfile) {
    throw new Error("Expected the avatar update to finish");
  }
  const update = profile.lastUpdate();
  if (!update) {
    throw new Error("Expected an avatar update request");
  }
  expect(savedProfile.avatarUrl).not.toBe("preset:0");
  expect(savedProfile.visibility).toBe("public");
  expect(update).not.toHaveProperty("visibility");
});

test("Keep the default agent’s canonical identity read-only", async () => {
  const defaultAgent: AgentResponse = {
    agentId: DEFAULT_AGENT_ID,
    ownerId: "test-user-123",
    description: "The default assistant",
    displayName: "Okou",
    sound: "professional",
    avatarUrl: DEFAULT_AGENT_AVATAR_URL,
    visibility: "public",
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
  };
  context.mocks.data.agents([defaultAgent]);
  context.mocks.api(agentsByIdContract.get, ({ respond }) => {
    return respond(200, defaultAgent);
  });
  context.mocks.api(agentInstructionsContract.get, ({ respond }) => {
    return respond(200, { content: null, filename: null });
  });
  context.mocks.data.onboardingStatus({ defaultAgentId: DEFAULT_AGENT_ID });

  await setupPage({
    context,
    path: `/agents/${DEFAULT_AGENT_ID}?tab=profile`,
  });

  const avatarLabel = await screen.findByText("Avatar", { selector: "p" });
  const avatarRow = avatarLabel.parentElement?.parentElement;
  if (!avatarRow) {
    throw new Error("Avatar profile row not found");
  }
  expect(within(avatarRow).getByRole("img", { name: "Okou" })).toHaveAttribute(
    "src",
    DEFAULT_AGENT_AVATAR_URL,
  );
  expect(screen.queryByLabelText("Customize avatar")).not.toBeInTheDocument();
  expect(
    within(avatarRow).queryByLabelText("Create custom avatar"),
  ).not.toBeInTheDocument();

  const nameLabel = screen.getByText("Name", { selector: "p" });
  const nameRow = nameLabel.parentElement?.parentElement;
  if (!nameRow) {
    throw new Error("Name profile row not found");
  }
  expect(within(nameRow).getByText("Okou")).toBeVisible();
  expect(within(nameRow).queryByLabelText("Name")).not.toBeInTheDocument();
});

test("Edit and save an agent profile", async () => {
  const profile = prepareAgentProfile();

  await setupPage({ context, path: `/agents/${AGENT_ID}?tab=profile` });

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
    expect(profile.lastSavedProfile()).toMatchObject({
      displayName: "Research Lead",
      description: "Helps with release research",
      sound: "friendly",
      visibility: "private",
    });
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
    expect(screen.getByText("Warm and approachable")).toBeInTheDocument();
  });

  click(tabByText("Instructions"));
  await waitFor(() => {
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });
  click(tabByText("Profile"));
  await expect(
    screen.findByDisplayValue("Research Lead"),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByDisplayValue("Helps with release research"),
  ).toBeInTheDocument();
  expect(screen.getByText("Warm and approachable")).toBeInTheDocument();
  expect(screen.getByLabelText("Make public")).toHaveAttribute(
    "aria-checked",
    "false",
  );
});

test("Discard unsaved agent profile edits", async () => {
  const profile = prepareAgentProfile();

  await setupPage({ context, path: `/agents/${AGENT_ID}?tab=profile` });

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

  click(screen.getByText("Discard"));

  await waitFor(() => {
    expect(
      screen.queryByText("You have unsaved changes"),
    ).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("Research Agent")).toBeInTheDocument();
    expect(screen.getByDisplayValue("A helpful agent")).toBeInTheDocument();
    expect(screen.getByText("Clear and polished")).toBeInTheDocument();
    expect(screen.getByLabelText("Make public")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(profile.lastSavedProfile()).toBeNull();
  });
});

test("Explain the impact before deleting an agent", async () => {
  const profile = prepareAgentProfile();

  await setupPage({ context, path: `/agents/${AGENT_ID}?tab=profile` });

  await findAgentNameInput();

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
  expect(screen.getByDisplayValue("Research Agent")).toBeInTheDocument();
  expect(profile.lastSavedProfile()).toBeNull();
});

test("Hide cancellation once agent deletion starts", async () => {
  prepareAgentProfile();
  const deleteResponse = context.mocks.deferred<void>();
  context.mocks.api(agentsByIdContract.delete, async ({ respond }) => {
    await deleteResponse.promise;
    return respond(204);
  });

  await setupPage({ context, path: `/agents/${AGENT_ID}?tab=profile` });

  await findAgentNameInput();
  click(screen.getByText("Delete agent"));

  const deleteDialog = await screen.findByRole("dialog");
  click(within(deleteDialog).getByText("Delete agent"));

  await waitFor(() => {
    expect(within(deleteDialog).getByText("Deleting…")).toBeInTheDocument();
    expect(
      queryAllByRoleFast("button", deleteDialog).some((button) => {
        return button.textContent?.trim() === "Cancel";
      }),
    ).toBeFalsy();
  });

  deleteResponse.resolve();

  await waitFor(() => {
    expect(screen.getByText("Agent deleted")).toBeInTheDocument();
  });
});
