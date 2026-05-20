import {
  adaptClientCredentialCodeExchange,
  adaptClientIdAuthUrl,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildTodoistAuthorizationUrl,
  exchangeTodoistCode,
  getTodoistSecretName,
} from "./todoist";
export const todoistHandler: OAuthConnectorProvider = {
  buildAuthUrl: adaptClientIdAuthUrl(buildTodoistAuthorizationUrl),
  exchangeCode: adaptClientCredentialCodeExchange(
    async (clientId, clientSecret, code, redirectUri) => {
      const result = await exchangeTodoistCode(
        clientId,
        clientSecret,
        code,
        redirectUri,
      );
      return {
        accessToken: result.accessToken,
        refreshToken: null,
        scopes: result.scopes,
        userInfo: {
          id: result.userInfo.id,
          username: result.userInfo.username,
          email: result.userInfo.email,
        },
      };
    },
  ),
  getClientId: (e) => {
    return e.TODOIST_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.TODOIST_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getTodoistSecretName,
};
