import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { zeroFeishuBrowserConnectContract } from "@vm0/api-contracts/contracts/zero-feishu-browser-connect";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function feishuConnectPath(): string {
  const params = new URLSearchParams({
    connect: "account",
    installationId: "7deaa595-f4eb-4b31-b083-70ed34c4a862",
    openId: "ou_feishu_user",
    chatId: "oc_feishu_dm",
    ts: "1784880000",
    sig: "signed-connect-token",
  });
  return `/settings/feishu?${params.toString()}`;
}

describe("zero Feishu connect page", () => {
  it("shows the Feishu account connection action", async () => {
    detachedSetupPage({
      context,
      path: feishuConnectPath(),
    });

    await waitFor(() => {
      expect(screen.getByText("Connect to Feishu")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Link your VM0 account to this Feishu bot/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
    expect(screen.getByText("Back to Feishu settings")).toBeInTheDocument();
  });

  it("shows the connected state after reloading the connect page", async () => {
    context.mocks.api(
      zeroFeishuBrowserConnectContract.getStatus,
      ({ respond }) => {
        return respond(200, {
          isConnected: true,
          botName: "Okou",
          openUrl: "https://applink.feishu.cn/client/bot/open?appId=cli_test",
        });
      },
    );
    detachedSetupPage({
      context,
      path: feishuConnectPath(),
    });

    await waitFor(() => {
      expect(screen.getByText("Connected to Feishu!")).toBeInTheDocument();
    });
    expect(screen.getByText(/You're connected to Okou/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open Feishu" }),
    ).toBeInTheDocument();
  });
});
