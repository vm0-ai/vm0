import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  zeroAgentInstructionsContract,
  zeroAgentsByIdContract,
} from "@vm0/api-contracts/contracts/zero-agents";

import { click, detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const AGENT_ID = "a0000000-0000-4000-a000-000000000010";

function prepareAgentInstructions(content: string | null): void {
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
      displayName: "Research Agent",
      description: "A helpful agent",
      sound: null,
      avatarUrl: null,
      customSkills: [],
      visibility: "public",
      headVersionId: "version_2",
      updatedAt: "2024-01-02T00:00:00Z",
    },
  ]);
  context.mocks.api(zeroAgentsByIdContract.get, ({ respond }) => {
    return respond(200, {
      agentId: AGENT_ID,
      ownerId: "test-user-123",
      description: "A helpful agent",
      displayName: "Research Agent",
      sound: null,
      avatarUrl: null,
      customSkills: [],
      visibility: "public",
    });
  });
  context.mocks.api(zeroAgentInstructionsContract.get, ({ respond }) => {
    return respond(200, { content, filename: null });
  });
}

describe("zero instructions tab", () => {
  it("does not mark initial markdown load as unsaved, then lets the user discard edits", async () => {
    const user = userEvent.setup();
    prepareAgentInstructions(
      "**Keep replies concise.**\n\n```ts\nconst ready = true;\n```",
    );

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}?tab=instructions`,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Research Agent" }),
      ).toBeInTheDocument();
      expect(screen.getByText(/Keep replies concise/u)).toBeInTheDocument();
      const editor = document.querySelector('[contenteditable="true"]');
      expect(editor?.textContent).toContain("const ready = true;");
    });
    expect(
      screen.queryByText("You have unsaved changes"),
    ).not.toBeInTheDocument();

    const editor = document.querySelector('[contenteditable="true"]');
    if (!(editor instanceof HTMLElement)) {
      throw new Error("instructions editor not found");
    }
    await user.click(editor);
    await user.keyboard("{Control>}a{/Control}Use bullet points");

    await waitFor(() => {
      expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
    });

    click(screen.getByText("Discard"));

    await waitFor(() => {
      expect(
        screen.queryByText("You have unsaved changes"),
      ).not.toBeInTheDocument();
    });
  });

  it("formats and saves edited instructions", async () => {
    const user = userEvent.setup({ delay: null });
    let savedInstructions = "Review release notes";
    let capturedBody: unknown = null;
    prepareAgentInstructions(savedInstructions);
    context.mocks.api(zeroAgentInstructionsContract.get, ({ respond }) => {
      return respond(200, { content: savedInstructions, filename: null });
    });
    context.mocks.api(
      zeroAgentInstructionsContract.update,
      ({ body, respond }) => {
        capturedBody = body;
        savedInstructions = body.content;
        return respond(200, {
          agentId: AGENT_ID,
          ownerId: "test-user-123",
          description: "A helpful agent",
          displayName: "Research Agent",
          sound: null,
          avatarUrl: null,
          customSkills: [],
          visibility: "public",
        });
      },
    );

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}?tab=instructions`,
    });

    await waitFor(() => {
      expect(screen.getByText("Review release notes")).toBeInTheDocument();
    });

    const editor = document.querySelector('[contenteditable="true"]');
    if (!(editor instanceof HTMLElement)) {
      throw new Error("instructions editor not found");
    }
    await user.click(editor);
    await user.keyboard("{Control>}a{/Control}");
    for (const title of [
      "Bold",
      "Italic",
      "Strikethrough",
      "Inline code",
      "Heading 1",
      "Heading 2",
      "Heading 3",
      "Bullet list",
      "Ordered list",
      "Blockquote",
    ]) {
      await user.click(await screen.findByTitle(title));
    }
    await user.click(editor);
    await user.keyboard(
      "{Control>}a{/Control}Review release notes with launch risks",
    );

    await waitFor(() => {
      expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
    });

    click(screen.getByTestId("save-button"));

    await waitFor(() => {
      expect(capturedBody).toStrictEqual({
        content: expect.stringContaining("Review release notes"),
      });
      expect(
        screen.queryByText("You have unsaved changes"),
      ).not.toBeInTheDocument();
    });
  });
});
