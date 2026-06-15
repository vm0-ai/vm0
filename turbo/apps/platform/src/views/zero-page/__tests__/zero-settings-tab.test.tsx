import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  zeroAgentInstructionsContract,
  zeroAgentsByIdContract,
  type ZeroAgentResponse,
} from "@vm0/api-contracts/contracts/zero-agents";

import {
  click,
  detachedSetupPage,
  fill,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const AGENT_ID = "a0000000-0000-4000-a000-000000000020";

function prepareAgentProfile(): void {
  let detail: ZeroAgentResponse = {
    agentId: AGENT_ID,
    ownerId: "test-user-123",
    description: "A helpful agent",
    displayName: "Research Agent",
    sound: "professional",
    avatarUrl: "preset:0",
    customSkills: [],
    visibility: "public",
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
  };

  context.mocks.data.team([
    {
      id: "c0000000-0000-4000-a000-000000000001",
      ownerId: "test-user-123",
      displayName: "Zero",
      description: null,
      sound: null,
      avatarUrl: null,
      customSkills: [],
      visibility: "public",
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    {
      id: AGENT_ID,
      ownerId: "test-user-123",
      displayName: detail.displayName,
      description: detail.description,
      sound: detail.sound,
      avatarUrl: detail.avatarUrl,
      customSkills: [],
      visibility: "public",
      headVersionId: "version_2",
      updatedAt: "2024-01-02T00:00:00Z",
    },
  ]);
  context.mocks.api(zeroAgentsByIdContract.get, ({ respond }) => {
    return respond(200, detail);
  });
  context.mocks.api(
    zeroAgentsByIdContract.updateMetadata,
    ({ body, respond }) => {
      detail = { ...detail, ...body };
      return respond(200, detail);
    },
  );
  context.mocks.api(zeroAgentInstructionsContract.get, ({ respond }) => {
    return respond(200, { content: null, filename: null });
  });
}

describe("zero settings tab", () => {
  it("creates and saves a custom avatar from the profile page", async () => {
    prepareAgentProfile();

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}?tab=profile` });

    click(await screen.findByLabelText("Create custom avatar"));

    await waitFor(() => {
      expect(
        screen.getAllByText("Give your agent a face").length,
      ).toBeGreaterThan(0);
      expect(screen.getByText("Angle")).toBeInTheDocument();
    });

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
    });

    click(screen.getByText("Chill"));
    click(screen.getByText("Use this avatar"));

    await waitFor(() => {
      expect(screen.queryAllByText("Give your agent a face")).toHaveLength(0);
      expect(screen.getByText("Profile saved")).toBeInTheDocument();
    });

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

  it("saves, discards, and confirms visible agent profile edits", async () => {
    prepareAgentProfile();

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}?tab=profile` });

    const nameInput = await screen.findByDisplayValue("Research Agent");
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
        screen.getByText(/instructions, automations, and all associated data/u),
      ).toBeInTheDocument();
    });

    click(screen.getByText("Cancel"));

    await waitFor(() => {
      expect(
        screen.queryByText(
          /instructions, automations, and all associated data/u,
        ),
      ).not.toBeInTheDocument();
    });
  });
});
