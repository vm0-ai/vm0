import { zeroFeishuBrowserConnectContract } from "@vm0/api-contracts/contracts/zero-feishu-browser-connect";
import { describe, expect, it } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../__tests__/test-helpers.ts";

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

describe("feishu connect redirect", () => {
  it("starts feishu OAuth without rendering a page", async () => {
    const authorizationUrl =
      "https://accounts.feishu.cn/open-apis/authen/v1/authorize?state=oauth-state";
    const locationAssign = context.mocks.browser.locationAssign();
    let connectBody: unknown;
    context.mocks.api(
      zeroFeishuBrowserConnectContract.connectFromApp,
      ({ body, respond }) => {
        connectBody = body;
        return respond(200, {
          success: true,
          botName: "Okou",
          openUrl: authorizationUrl,
        });
      },
    );

    await setupPage({
      context,
      path: feishuConnectPath(),
      withoutRender: true,
    });

    expect(locationAssign.calls).toStrictEqual([authorizationUrl]);
    expect(connectBody).toStrictEqual({
      installationId: "7deaa595-f4eb-4b31-b083-70ed34c4a862",
      openId: "ou_feishu_user",
      chatId: "oc_feishu_dm",
      ts: 1_784_880_000,
      sig: "signed-connect-token",
    });
  });
});
