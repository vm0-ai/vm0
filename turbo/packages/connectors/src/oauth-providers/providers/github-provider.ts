import {
  requireOAuthClientCredentials,
  requireOAuthClientId,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildGitHubAuthorizationUrl,
  exchangeGitHubCode,
  fetchGitHubUserInfo,
  getGitHubSecretName,
  revokeGitHubGrant,
} from "./github";
export const githubProvider: OAuthConnectorProvider = {
  buildAuthUrl: (args) => {
    const clientId = requireOAuthClientId(args);
    return buildGitHubAuthorizationUrl(clientId, args.redirectUri, args.state);
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    const code = args.code;
    const redirectUri = args.redirectUri;
    const { accessToken, scopes } = await exchangeGitHubCode(
      clientId,
      clientSecret,
      code,
      redirectUri,
    );
    const userInfo = await fetchGitHubUserInfo(accessToken);
    return { accessToken, scopes, userInfo };
  },
  getClientId: (e) => {
    return e.GH_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.GH_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getGitHubSecretName,
  revokeToken: (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    return revokeGitHubGrant(clientId, clientSecret, args.accessToken);
  },
};
