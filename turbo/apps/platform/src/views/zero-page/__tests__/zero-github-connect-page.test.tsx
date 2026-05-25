import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { click, detachedSetupPage } from "../../../__tests__/page-helper.ts";
import {
  createDefaultMockGithubIntegration,
  getMockGithubIntegration,
  setMockGithubIntegration,
} from "../../../mocks/handlers/api-integrations-github.ts";

const context = testContext();

function setupGithubConnectPage(path: string) {
  detachedSetupPage({ context, path });
}

describe("github connect page", () => {
  it("connects a GitHub mention link inside the app", async () => {
    setMockGithubIntegration(
      createDefaultMockGithubIntegration({
        isConnected: false,
        connectedGithubUserId: null,
        connectedGithubUsername: null,
      }),
    );

    setupGithubConnectPage(
      "/github/connect?installation=123456&ghUser=111222&ghLogin=octocat&ts=1777200000&sig=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );

    await expect(screen.findByText("Connect to GitHub")).resolves.toBeVisible();
    click(screen.getByText("Connect"));

    await waitFor(() => {
      expect(screen.getByText("Connected to GitHub!")).toBeInTheDocument();
    });
    expect(getMockGithubIntegration()).toMatchObject({
      isConnected: true,
      connectedGithubUserId: "111222",
      connectedGithubUsername: "octocat",
    });
  });

  it("shows an invalid state for incomplete links", async () => {
    setupGithubConnectPage("/github/connect?installation=123456");

    await expect(
      screen.findByText("Connect link is incomplete"),
    ).resolves.toBeVisible();
  });
});
