import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function buttonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

function githubConnectPath(): string {
  const params = new URLSearchParams({
    installation: "123456",
    ghUser: "24680",
    ghLogin: "octo-dev",
    ts: "1700000000",
    sig: "a".repeat(64),
  });
  return `/github/connect?${params.toString()}`;
}

describe("zero GitHub connect page", () => {
  it("links the GitHub user and shows the connected state", async () => {
    context.mocks.data.githubIntegration(
      context.mocks.data.defaultGithubIntegration({
        isConnected: false,
        connectedGithubUserId: null,
        connectedGithubUsername: null,
      }),
    );

    detachedSetupPage({ context, path: githubConnectPath() });

    await waitFor(() => {
      expect(screen.getByText("Connect to GitHub")).toBeInTheDocument();
    });
    expect(screen.getByText("@octo-dev")).toBeInTheDocument();

    click(buttonByText("Connect"));

    await waitFor(() => {
      expect(screen.getByText("Connected to GitHub!")).toBeInTheDocument();
    });
    expect(screen.getByText("@octo-dev")).toBeInTheDocument();
    expect(screen.getByText("Back to GitHub settings")).toBeInTheDocument();
  });
});
