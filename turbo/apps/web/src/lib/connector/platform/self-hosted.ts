/**
 * Self-hosted platform adapter for existing GitHub and Notion OAuth implementations.
 *
 * This adapter wraps the existing provider functions to conform to the
 * ConnectorPlatform interface, allowing them to work alongside Nango-based providers.
 */

import {
  buildGitHubAuthorizationUrl,
  exchangeGitHubCode,
  fetchGitHubUserInfo,
} from "../providers/github";
import {
  buildNotionAuthorizationUrl,
  exchangeNotionCode,
} from "../providers/notion";
import type {
  ConnectorPlatform,
  AuthorizationParams,
  CallbackParams,
  ConnectorResult,
} from "./interface";

async function buildAuthorizationUrl(
  params: AuthorizationParams,
): Promise<string> {
  const env = globalThis.services.env;

  switch (params.type) {
    case "github": {
      const clientId = env.GH_OAUTH_CLIENT_ID;
      if (!clientId) {
        throw new Error("GitHub OAuth not configured");
      }
      return buildGitHubAuthorizationUrl(
        clientId,
        params.redirectUri,
        params.state,
      );
    }

    case "notion": {
      const clientId = env.NOTION_OAUTH_CLIENT_ID;
      if (!clientId) {
        throw new Error("Notion OAuth not configured");
      }
      return buildNotionAuthorizationUrl(
        clientId,
        params.redirectUri,
        params.state,
      );
    }

    default:
      throw new Error(
        `Self-hosted platform does not support connector type: ${params.type}`,
      );
  }
}

async function handleCallback(
  params: CallbackParams,
): Promise<ConnectorResult> {
  const env = globalThis.services.env;

  switch (params.type) {
    case "github": {
      const clientId = env.GH_OAUTH_CLIENT_ID;
      const clientSecret = env.GH_OAUTH_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        throw new Error("GitHub OAuth not configured");
      }

      const { accessToken, scopes } = await exchangeGitHubCode(
        clientId,
        clientSecret,
        params.code,
        params.redirectUri,
      );

      const userInfo = await fetchGitHubUserInfo(accessToken);

      return {
        externalId: userInfo.id,
        externalUsername: userInfo.username,
        externalEmail: userInfo.email,
        oauthScopes: scopes,
        accessToken,
      };
    }

    case "notion": {
      const clientId = env.NOTION_OAUTH_CLIENT_ID;
      const clientSecret = env.NOTION_OAUTH_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        throw new Error("Notion OAuth not configured");
      }

      const result = await exchangeNotionCode(
        clientId,
        clientSecret,
        params.code,
        params.redirectUri,
      );

      return {
        externalId: result.userInfo.id,
        externalUsername: result.userInfo.username,
        externalEmail: result.userInfo.email,
        oauthScopes: result.scopes,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
      };
    }

    default:
      throw new Error(
        `Self-hosted platform does not support connector type: ${params.type}`,
      );
  }
}

export const SelfHostedPlatform: ConnectorPlatform = {
  name: "self-hosted",
  buildAuthorizationUrl,
  handleCallback,
};
