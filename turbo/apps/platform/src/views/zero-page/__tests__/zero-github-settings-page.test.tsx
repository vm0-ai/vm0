import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function setupGithubPage(): void {
  detachedSetupPage({
    context,
    path: "/settings/github",
  });
}

describe("github settings page", () => {
  it("returns to integrations from the settings header", async () => {
    context.mocks.data.githubIntegration(
      context.mocks.data.defaultGithubIntegration(),
    );

    setupGithubPage();

    click(await screen.findByText("Back to integrations"));

    await waitFor(() => {
      expect(screen.getByText("Where Zero works")).toBeInTheDocument();
    });
  });

  it("creates, edits, and deletes a GitHub label listener", async () => {
    context.mocks.data.githubIntegration(
      context.mocks.data.defaultGithubIntegration({
        labelListeners: [],
      }),
    );

    setupGithubPage();

    await waitFor(() => {
      expect(screen.getByText("Label listeners")).toBeInTheDocument();
    });
    click(screen.getByText("Add listener"));

    const createDialog = await screen.findByRole("dialog");
    await fill(within(createDialog).getByLabelText("Label"), "ready-for-zero");
    await fill(
      within(createDialog).getByLabelText("Prompt"),
      "Review the labeled issue or pull request.",
    );
    click(within(createDialog).getByText("Any author"));
    click(within(createDialog).getByText("Add listener"));

    await waitFor(() => {
      expect(screen.getByText("ready-for-zero")).toBeInTheDocument();
      expect(screen.getByText("Any author")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Actions for ready-for-zero"));
    click(await screen.findByText("Edit"));

    const editDialog = await screen.findByRole("dialog");
    await fill(within(editDialog).getByLabelText("Label"), "needs-agent");
    await fill(
      within(editDialog).getByLabelText("Prompt"),
      "Review and fix the labeled issue or pull request.",
    );
    click(within(editDialog).getByText("Save changes"));

    await waitFor(() => {
      expect(screen.getByText("needs-agent")).toBeInTheDocument();
      expect(screen.queryByText("ready-for-zero")).not.toBeInTheDocument();
      expect(screen.queryByText("Disabled")).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Actions for needs-agent"));
    click(await screen.findByText("Delete"));

    await waitFor(() => {
      expect(screen.queryByText("needs-agent")).not.toBeInTheDocument();
    });
  });

  it("shows read-only label listeners without row actions", async () => {
    context.mocks.data.githubIntegration(
      context.mocks.data.defaultGithubIntegration({
        labelListeners: [
          {
            id: "b0000000-0000-4000-a000-000000000001",
            labelName: "ready-for-zero",
            triggerMode: "created_by_me",
            prompt: "Review the labeled issue or pull request.",
            enabled: true,
            canManage: false,
            agent: {
              id: "c0000000-0000-4000-a000-000000000001",
              name: "zero",
            },
            createdAt: "1970-01-01T00:00:00.000Z",
            updatedAt: "1970-01-01T00:00:00.000Z",
          },
        ],
      }),
    );

    setupGithubPage();

    await waitFor(() => {
      expect(screen.getByText("ready-for-zero")).toBeInTheDocument();
      expect(screen.getByText("Created by me")).toBeInTheDocument();
      expect(
        screen.queryByLabelText("Actions for ready-for-zero"),
      ).not.toBeInTheDocument();
    });
  });
});
