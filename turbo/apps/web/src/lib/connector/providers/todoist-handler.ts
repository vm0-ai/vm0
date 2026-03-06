import { type ProviderHandler } from "../provider-types";
import {
  buildTodoistAuthorizationUrl,
  exchangeTodoistCode,
  getTodoistSecretName,
} from "./todoist";

export const todoistHandler: ProviderHandler = {
  buildAuthUrl: buildTodoistAuthorizationUrl,
  async exchangeCode(clientId, clientSecret, code) {
    const result = await exchangeTodoistCode(clientId, clientSecret, code);
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
  getClientId: (e) => e.TODOIST_OAUTH_CLIENT_ID,
  getClientSecret: (e) => e.TODOIST_OAUTH_CLIENT_SECRET,
  getSecretName: getTodoistSecretName,
};
