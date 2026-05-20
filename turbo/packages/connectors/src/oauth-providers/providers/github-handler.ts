import {
  adaptClientCredentialCodeExchange,
  adaptClientCredentialTokenRevocation,
  adaptClientIdAuthUrl,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildGitHubAuthorizationUrl,
  exchangeGitHubCode,
  fetchGitHubUserInfo,
  getGitHubSecretName,
  revokeGitHubGrant,
} from "./github";
export const githubHandler: OAuthConnectorProvider = {
  buildAuthUrl: adaptClientIdAuthUrl(buildGitHubAuthorizationUrl),
  exchangeCode: adaptClientCredentialCodeExchange(
    async (clientId, clientSecret, code, redirectUri) => {
      const { accessToken, scopes } = await exchangeGitHubCode(
        clientId,
        clientSecret,
        code,
        redirectUri,
      );
      const userInfo = await fetchGitHubUserInfo(accessToken);
      return { accessToken, scopes, userInfo };
    },
  ),
  getClientId: (e) => {
    return e.GH_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.GH_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getGitHubSecretName,
  revokeToken: adaptClientCredentialTokenRevocation(revokeGitHubGrant),
};
