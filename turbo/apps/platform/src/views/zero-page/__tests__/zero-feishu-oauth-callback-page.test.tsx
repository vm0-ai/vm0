import { zeroFeishuOauthContract } from "@vm0/api-contracts/contracts/zero-feishu-oauth";
import {
  zeroConnectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { getStaticConnectorIconMetadata } from "@vm0/connectors/static-connector-icons";
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function feishuConnectorStatus(): PublicConnectorCatalogStatusItem {
  return {
    connectorRef: "lark",
    label: "Feishu",
    description: "Connect Feishu to VM0.",
    icon: getStaticConnectorIconMetadata("lark"),
    category: "communication",
    generation: [],
    tags: [],
    authMethods: [],
    permissionSummary: {
      hasPermissions: false,
      permissionCount: 0,
      hasCategories: false,
      hasDefaultPolicyOverrides: false,
    },
    connection: null,
    connected: false,
    connectionStatus: "not-connected",
    scopeMismatch: false,
    authMethodSupportsRefresh: false,
    tokenExpiresAt: null,
    singleAuthCodeAuthMethodId: null,
    connectNotice: null,
  };
}

describe("feishu OAuth callback page", () => {
  it("completes OAuth through the API and opens the Feishu bot", async () => {
    const redirectUrl =
      "https://applink.feishu.cn/client/bot/open?appId=cli_test";
    const locationAssign = context.mocks.browser.locationAssign();
    let callbackQuery: unknown;
    context.mocks.api(zeroConnectorCatalogContract.status, ({ respond }) => {
      return respond(200, { connectors: [feishuConnectorStatus()] });
    });
    context.mocks.api(
      zeroFeishuOauthContract.callback,
      ({ query, respond }) => {
        callbackQuery = query;
        return respond(200, { redirectUrl });
      },
    );

    detachedSetupPage({
      context,
      path: "/connectors/feishu/callback?code=oauth-code&state=oauth-state",
      user: null,
      session: null,
    });

    const heading = await screen.findByRole("heading", {
      name: "Connecting Feishu…",
    });
    const connectorIcon = heading.parentElement?.querySelector("img");
    if (!(connectorIcon instanceof HTMLImageElement)) {
      throw new Error("Feishu connector icon not found");
    }
    expect(connectorIcon).toHaveAttribute(
      "src",
      getStaticConnectorIconMetadata("lark").url,
    );
    await waitFor(() => {
      expect(locationAssign.calls).toStrictEqual([redirectUrl]);
    });
    expect(callbackQuery).toStrictEqual({
      code: "oauth-code",
      responseMode: "json",
      state: "oauth-state",
    });
  });
});
