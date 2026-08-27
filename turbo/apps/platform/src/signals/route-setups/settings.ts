import { setupBankingConnectReturnPage$ } from "../banking-connect-return-page-setup.ts";
import { setupConnectorCallbackPage$ } from "../connectors-page/connector-callback-page-setup.ts";
import { setupConnectorRedirectingPage$ } from "../connectors-page/connector-redirecting-page-setup.ts";
import { setupConnectorsPage$ } from "../connectors-page/connectors-page-setup.ts";
import { setupDirectedAuthorizePage$ } from "../connectors-page/directed-authorize-page-setup.ts";
import { setupDirectedConnectPage$ } from "../connectors-page/directed-connect-page-setup.ts";
import { setupAgentPhoneConnectPage$ } from "../okou-page/agentphone-connect-page.ts";
import { setupFeishuOAuthCallbackPage$ } from "../okou-page/feishu-oauth-callback-page.ts";
import { setupFeishuSettingsPage$ } from "../okou-page/feishu-settings-page.ts";
import { setupGithubConnectPage$ } from "../okou-page/github-connect-page.ts";
import { setupSlackConnectPage$ } from "../okou-page/slack-connect-page.ts";
import { setupStrapiSettingsPage$ } from "../okou-page/strapi-settings-page.ts";
import { setupTeamsConnectPage$ } from "../okou-page/teams-connect-page.ts";
import { setupTelegramConnectPage$ } from "../okou-page/telegram-connect-page.ts";
import { setupTelegramSettingsPage$ } from "../okou-page/telegram-settings-page.ts";
import { setupPreferencesPage$ } from "../preferences-page/preferences-page-setup.ts";
import { setupRedeemCampaignPage$ } from "../redeem-campaign/redeem-campaign-page-setup.ts";

export function getSettingsRouteSetups() {
  return {
    setupAgentPhoneConnectPage$,
    setupBankingConnectReturnPage$,
    setupConnectorCallbackPage$,
    setupConnectorRedirectingPage$,
    setupConnectorsPage$,
    setupDirectedAuthorizePage$,
    setupDirectedConnectPage$,
    setupFeishuOAuthCallbackPage$,
    setupFeishuSettingsPage$,
    setupGithubConnectPage$,
    setupPreferencesPage$,
    setupRedeemCampaignPage$,
    setupSlackConnectPage$,
    setupStrapiSettingsPage$,
    setupTeamsConnectPage$,
    setupTelegramConnectPage$,
    setupTelegramSettingsPage$,
  };
}
