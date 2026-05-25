import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  click,
  detachedSetupPage,
  fill,
} from "../../../__tests__/page-helper.ts";
import {
  createDefaultMockGithubIntegration,
  getMockGithubIntegration,
  setMockGithubIntegration,
} from "../../../mocks/handlers/api-integrations-github.ts";
import { pathname$ } from "../../../signals/route.ts";
import { hasSubscription, triggerAblyEvent } from "../../../mocks/ably.ts";

const context = testContext();

function setupGithubPage() {
  detachedSetupPage({
    context,
    path: "/settings/github",
  });
}

describe("github settings page", () => {
  it("does not show the connected GitHub username in the header", async () => {
    setMockGithubIntegration(
      createDefaultMockGithubIntegration({
        isConnected: true,
        connectedGithubUsername: "octocat",
      }),
    );

    setupGithubPage();

    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });
    expect(screen.queryByText("Connected (@octocat)")).not.toBeInTheDocument();
    expect(screen.getByText("Connected as @octocat")).toBeInTheDocument();
  });

  it("returns to the integrations list from the header", async () => {
    setMockGithubIntegration(createDefaultMockGithubIntegration());
    setupGithubPage();

    click(await screen.findByText("Back to integrations"));

    await waitFor(() => {
      expect(context.store.get(pathname$)).toBe("/works");
    });
  });

  it("shows connection and danger zone action cards", async () => {
    setMockGithubIntegration(
      createDefaultMockGithubIntegration({
        isConnected: false,
        connectedGithubUserId: null,
        connectedGithubUsername: null,
      }),
    );
    setupGithubPage();

    await waitFor(() => {
      expect(screen.getByText("Connection")).toBeInTheDocument();
      expect(screen.getByText("Danger zone")).toBeInTheDocument();
      expect(
        screen.getByTestId("github-installation-target"),
      ).toHaveTextContent("(Installed on @vm0-test)");
      expect(screen.getByText("Connect")).toBeInTheDocument();
      expect(screen.getByText("Uninstall")).toBeInTheDocument();
    });
  });

  it("refreshes from the route-level GitHub realtime subscription", async () => {
    const integration = createDefaultMockGithubIntegration({
      isConnected: false,
      connectedGithubUserId: null,
      connectedGithubUsername: null,
    });
    setMockGithubIntegration(integration);
    setupGithubPage();

    await waitFor(() => {
      expect(screen.getByText("Connect")).toBeInTheDocument();
      expect(hasSubscription("github:changed")).toBeTruthy();
    });

    setMockGithubIntegration({
      ...integration,
      isConnected: true,
      connectedGithubUserId: "98765",
      connectedGithubUsername: "octocat",
    });
    triggerAblyEvent("github:changed");

    await waitFor(() => {
      expect(screen.getByText("Connected as @octocat")).toBeInTheDocument();
    });
  });

  it("disconnects the GitHub account from the connection card", async () => {
    setMockGithubIntegration(
      createDefaultMockGithubIntegration({
        isConnected: true,
        connectedGithubUserId: "98765",
        connectedGithubUsername: "octocat",
      }),
    );
    setupGithubPage();

    click(await screen.findByText("Disconnect"));

    await waitFor(() => {
      expect(getMockGithubIntegration()?.isConnected).toBeFalsy();
      expect(screen.getByText("Connect")).toBeInTheDocument();
    });
  });

  it("uninstalls GitHub from the danger zone", async () => {
    setMockGithubIntegration(createDefaultMockGithubIntegration());
    setupGithubPage();

    click(await screen.findByText("Uninstall"));
    const dialog = await screen.findByRole("dialog");
    click(within(dialog).getByText("Uninstall"));

    await waitFor(() => {
      expect(getMockGithubIntegration()).toBeNull();
      expect(screen.getByText("GitHub is not installed.")).toBeInTheDocument();
    });
  });

  it("creates a GitHub label listener with the any-label trigger mode", async () => {
    setMockGithubIntegration(
      createDefaultMockGithubIntegration({
        labelListeners: [],
      }),
    );
    setupGithubPage();

    await waitFor(() => {
      expect(screen.getByText("Label listeners")).toBeInTheDocument();
      expect(
        screen.getByText(
          "Add a label listener to run an agent when a GitHub issue or pull request gets a matching label.",
        ),
      ).toBeInTheDocument();
    });
    click(screen.getByText("Add listener"));

    const dialog = await screen.findByRole("dialog");
    await fill(within(dialog).getByLabelText("Label"), "ready-for-zero");
    await fill(
      within(dialog).getByLabelText("Prompt"),
      "Review the labeled issue or pull request.",
    );

    click(within(dialog).getByText("Any author"));

    click(within(dialog).getByText("Add listener"));

    await waitFor(() => {
      const integration = getMockGithubIntegration();
      expect(integration?.labelListeners).toHaveLength(1);
      expect(integration?.labelListeners[0]?.triggerMode).toBe("anyone");
      expect(integration?.labelListeners[0]?.enabled).toBeTruthy();
    });
    expect(screen.getByText("ready-for-zero")).toBeInTheDocument();
    expect(screen.getByText("Any author")).toBeInTheDocument();
    expect(
      screen.queryByText(/Any issue\/PR with this label/u),
    ).not.toBeInTheDocument();
  });

  it("edits and deletes a GitHub label listener from the actions menu", async () => {
    setMockGithubIntegration(
      createDefaultMockGithubIntegration({
        labelListeners: [
          {
            id: "b0000000-0000-4000-a000-000000000001",
            labelName: "ready-for-zero",
            triggerMode: "created_by_me",
            prompt: "Review the labeled issue or pull request.",
            enabled: false,
            canManage: true,
            agent: {
              id: "c0000000-0000-4000-a000-000000000001",
              name: "zero",
            },
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          },
        ],
      }),
    );
    setupGithubPage();

    await expect(
      screen.findByText("ready-for-zero"),
    ).resolves.toBeInTheDocument();
    expect(screen.getByText("Created by me")).toBeInTheDocument();
    expect(screen.getByText("Disabled")).toBeInTheDocument();

    click(screen.getByLabelText("Actions for ready-for-zero"));
    click(await screen.findByText("Edit"));

    const editDialog = await screen.findByRole("dialog");
    const enableSwitch = within(editDialog).getByRole("switch", {
      name: "Enable listener",
    });
    expect(enableSwitch).not.toBeChecked();
    click(enableSwitch);
    expect(
      within(editDialog).getByRole("switch", { name: "Disable listener" }),
    ).toBeChecked();
    await fill(within(editDialog).getByLabelText("Label"), "needs-agent");
    await fill(
      within(editDialog).getByLabelText("Prompt"),
      "Review and fix the labeled issue or pull request.",
    );
    click(within(editDialog).getByText("Save changes"));

    await waitFor(() => {
      const integration = getMockGithubIntegration();
      expect(integration?.labelListeners[0]?.labelName).toBe("needs-agent");
      expect(integration?.labelListeners[0]?.enabled).toBeTruthy();
      expect(screen.getByText("needs-agent")).toBeInTheDocument();
      expect(screen.queryByText("Disabled")).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Actions for needs-agent"));
    click(await screen.findByText("Delete"));

    await waitFor(() => {
      const integration = getMockGithubIntegration();
      expect(integration?.labelListeners).toHaveLength(0);
      expect(screen.queryByText("needs-agent")).not.toBeInTheDocument();
    });
  });

  it("shows read-only label listeners without row actions", async () => {
    setMockGithubIntegration(
      createDefaultMockGithubIntegration({
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
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
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
