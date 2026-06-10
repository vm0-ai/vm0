import { screen, waitFor } from "@testing-library/react";
import { zeroSlackConnectContract } from "@vm0/api-contracts/contracts/zero-slack-connect";
import { describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function slackConnectPath(): string {
  const params = new URLSearchParams({
    w: "T123456",
    u: "U987654",
    workspace: "Acme Workspace",
  });
  return `/settings/slack?${params.toString()}`;
}

describe("zero Slack connect page", () => {
  it("shows invalid Slack connect links without attempting a connection", async () => {
    detachedSetupPage({
      context,
      path: "/settings/slack",
    });

    await waitFor(() => {
      expect(screen.getByText("Invalid Link")).toBeInTheDocument();
      expect(
        screen.getByText(
          "This page is meant to be opened from a Slack connect link.",
        ),
      ).toBeInTheDocument();
      expect(screen.getByText("Back to settings")).toBeInTheDocument();
    });
  });

  it("shows Slack callback errors", async () => {
    detachedSetupPage({
      context,
      path: "/settings/slack?error=Slack%20authorization%20expired",
    });

    await waitFor(() => {
      expect(screen.getByText("Connection Failed")).toBeInTheDocument();
      expect(
        screen.getByText("Slack authorization expired"),
      ).toBeInTheDocument();
      expect(screen.getByText("Back to settings")).toBeInTheDocument();
    });
  });

  it("shows Slack workspace links that can be connected", async () => {
    context.mocks.api(zeroSlackConnectContract.getStatus, ({ respond }) => {
      return respond(200, {
        isConnected: false,
        isAdmin: false,
        workspaceName: "Acme Workspace",
      });
    });

    const params = new URLSearchParams({
      w: "T123456",
      u: "U987654",
      c: "C999999",
      t: "1733856000.000100",
      workspace: "Acme Workspace",
    });
    detachedSetupPage({
      context,
      path: `/settings/slack?${params.toString()}`,
    });

    await waitFor(() => {
      expect(screen.getByText("Connect to Slack")).toBeInTheDocument();
      expect(
        screen.getByText(
          "Link your account to this Slack workspace so you can interact with your agent directly from Slack.",
        ),
      ).toBeInTheDocument();
      expect(screen.getByText("Connect")).toBeEnabled();
    });
  });

  it("shows the connected Slack workspace state", async () => {
    context.mocks.api(zeroSlackConnectContract.getStatus, ({ respond }) => {
      return respond(200, {
        isConnected: true,
        isAdmin: false,
        workspaceName: "Acme Workspace",
      });
    });

    detachedSetupPage({
      context,
      path: slackConnectPath(),
    });

    await waitFor(() => {
      expect(screen.getByText("Connected to Slack!")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/You're connected to Acme Workspace/),
    ).toBeInTheDocument();
    expect(screen.getByText("Open Slack")).toBeInTheDocument();
    expect(screen.getByText("Back to settings")).toBeInTheDocument();
  });
});
