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
