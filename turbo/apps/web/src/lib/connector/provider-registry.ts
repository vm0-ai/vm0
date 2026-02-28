import { type ConnectorType } from "@vm0/core";
import { type Env } from "../../env";
import {
  buildGitHubAuthorizationUrl,
  exchangeGitHubCode,
  fetchGitHubUserInfo,
  getGitHubSecretName,
} from "./providers/github";
import {
  buildNotionAuthorizationUrl,
  exchangeNotionCode,
  getNotionSecretName,
} from "./providers/notion";
import {
  buildSlackAuthorizationUrl,
  exchangeSlackCode,
  fetchSlackUserInfo,
  getSlackSecretName,
} from "./providers/slack";

export interface OAuthTokenResult {
  accessToken: string;
  scopes: string[];
  userInfo: { id: string; username: string | null; email: string | null };
}

interface ProviderHandler {
  buildAuthUrl(clientId: string, redirectUri: string, state: string): string;
  exchangeCode(
    clientId: string,
    clientSecret: string,
    code: string,
    redirectUri: string,
  ): Promise<OAuthTokenResult>;
  getClientId(currentEnv: Env): string | undefined;
  getClientSecret(currentEnv: Env): string | undefined;
  getSecretName(): string;
}

export const PROVIDER_HANDLERS = {
  github: {
    buildAuthUrl: buildGitHubAuthorizationUrl,
    async exchangeCode(clientId, clientSecret, code, redirectUri) {
      const { accessToken, scopes } = await exchangeGitHubCode(
        clientId,
        clientSecret,
        code,
        redirectUri,
      );
      const userInfo = await fetchGitHubUserInfo(accessToken);
      return { accessToken, scopes, userInfo };
    },
    getClientId: (e) => e.GH_OAUTH_CLIENT_ID,
    getClientSecret: (e) => e.GH_OAUTH_CLIENT_SECRET,
    getSecretName: getGitHubSecretName,
  },
  notion: {
    buildAuthUrl: buildNotionAuthorizationUrl,
    async exchangeCode(clientId, clientSecret, code, redirectUri) {
      const result = await exchangeNotionCode(
        clientId,
        clientSecret,
        code,
        redirectUri,
      );
      return {
        accessToken: result.accessToken,
        scopes: result.scopes,
        userInfo: result.userInfo,
      };
    },
    getClientId: (e) => e.NOTION_OAUTH_CLIENT_ID,
    getClientSecret: (e) => e.NOTION_OAUTH_CLIENT_SECRET,
    getSecretName: getNotionSecretName,
  },
  slack: {
    buildAuthUrl: buildSlackAuthorizationUrl,
    async exchangeCode(clientId, clientSecret, code, redirectUri) {
      const slackResult = await exchangeSlackCode(
        clientId,
        clientSecret,
        code,
        redirectUri,
      );
      const slackUser = await fetchSlackUserInfo(
        slackResult.userId,
        slackResult.accessToken,
      );
      return {
        accessToken: slackResult.accessToken,
        scopes: slackResult.scopes,
        userInfo: {
          id: slackUser.id,
          username: slackUser.username,
          email: slackUser.email,
        },
      };
    },
    getClientId: (e) => e.SLACK_CLIENT_ID,
    getClientSecret: (e) => e.SLACK_CLIENT_SECRET,
    getSecretName: getSlackSecretName,
  },
} as Record<Exclude<ConnectorType, "computer">, ProviderHandler>;
