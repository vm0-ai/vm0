import { screen, waitFor } from "@testing-library/react";
import { integrationsGithubContract } from "@vm0/api-contracts/contracts/integrations-github";
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

function githubConnectPath(
  overrides: {
    installation?: string;
    ghUser?: string;
    ghLogin?: string;
    ts?: string;
    sig?: string;
  } = {},
): string {
  const params = new URLSearchParams({
    installation: overrides.installation ?? "123456",
    ghUser: overrides.ghUser ?? "24680",
    ghLogin: overrides.ghLogin ?? "octo-dev",
    ts: overrides.ts ?? "1700000000",
    sig: overrides.sig ?? "a".repeat(64),
  });
  return `/github/connect?${params.toString()}`;
}

function mockReadyGithubIntegration(): void {
  context.mocks.data.githubIntegration(
    context.mocks.data.defaultGithubIntegration({
      isConnected: false,
      connectedGithubUserId: null,
      connectedGithubUsername: null,
    }),
  );
}

describe("zero GitHub connect page", () => {
  it("links the GitHub user and shows the connected state", async () => {
    mockReadyGithubIntegration();

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

  it("shows invalid-link guidance before checking account state", async () => {
    detachedSetupPage({
      context,
      path: `/github/connect?installation=not-a-number&ghUser=24680&ts=1700000000&sig=${"a".repeat(64)}`,
    });

    await waitFor(() => {
      expect(screen.getByText("Connect link is invalid")).toBeInTheDocument();
      expect(
        screen.getByText("The GitHub installation on this link is not valid."),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Back to GitHub settings")).toBeInTheDocument();
  });

  it("shows invalid-link guidance for malformed GitHub user ids", async () => {
    detachedSetupPage({
      context,
      path: githubConnectPath({ ghUser: "not-a-number" }),
    });

    await waitFor(() => {
      expect(screen.getByText("Connect link is invalid")).toBeInTheDocument();
      expect(
        screen.getByText("The GitHub user on this link is not valid."),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Back to GitHub settings")).toBeInTheDocument();
  });

  it("shows invalid-link guidance for malformed signatures", async () => {
    detachedSetupPage({
      context,
      path: githubConnectPath({ sig: "not-a-signature" }),
    });

    await waitFor(() => {
      expect(screen.getByText("Connect link is invalid")).toBeInTheDocument();
      expect(
        screen.getByText("The signature on this link is not valid."),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Back to GitHub settings")).toBeInTheDocument();
  });

  it("shows the already-connected state for the same GitHub user", async () => {
    context.mocks.data.githubIntegration(
      context.mocks.data.defaultGithubIntegration({
        isConnected: true,
        connectedGithubUserId: "24680",
        connectedGithubUsername: null,
      }),
    );

    detachedSetupPage({ context, path: githubConnectPath() });

    await waitFor(() => {
      expect(
        screen.getByText("Already connected to GitHub"),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("@octo-dev")).toBeInTheDocument();
  });

  it("explains installation problems instead of showing the connect action", async () => {
    context.mocks.data.githubIntegration(null);

    detachedSetupPage({ context, path: githubConnectPath() });

    await waitFor(() => {
      expect(screen.getByText("GitHub is not installed")).toBeInTheDocument();
      expect(
        screen.getByText(
          "Ask an organization admin to install GitHub before connecting your account.",
        ),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText("Connect")).not.toBeInTheDocument();
  });

  it("asks users to switch organization for another installation", async () => {
    const integration = context.mocks.data.defaultGithubIntegration();
    context.mocks.data.githubIntegration({
      ...integration,
      installation: {
        ...integration.installation,
        installationId: "999999",
      },
    });

    detachedSetupPage({ context, path: githubConnectPath() });

    await waitFor(() => {
      expect(screen.getByText("Switch organization")).toBeInTheDocument();
      expect(
        screen.getByText(
          "Your active organization doesn't match this GitHub installation. Switch to the correct organization and open the link again.",
        ),
      ).toBeInTheDocument();
    });
  });

  it("surfaces a connect failure and keeps the connect action available", async () => {
    mockReadyGithubIntegration();
    context.mocks.api(integrationsGithubContract.connectUser, ({ respond }) => {
      return respond(500, {
        error: {
          message: "GitHub token expired",
          code: "INTERNAL_SERVER_ERROR",
        },
      });
    });

    detachedSetupPage({ context, path: githubConnectPath() });

    await waitFor(() => {
      expect(screen.getByText("Connect to GitHub")).toBeInTheDocument();
    });

    click(buttonByText("Connect"));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "GitHub token expired",
      );
      expect(buttonByText("Connect")).toBeInTheDocument();
    });
  });
});
