import { defineConnectorOAuthProvider } from "../provider-types";
import {
  buildTodoistAuthorizationUrl,
  exchangeTodoistCode,
  getTodoistSecretName,
} from "./todoist";
export const todoistProvider = defineConnectorOAuthProvider("todoist", {
  buildAuthUrl: (args) => {
    const { clientId } = args;
    return buildTodoistAuthorizationUrl(clientId, args.redirectUri, args.state);
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = args;
    const code = args.code;
    const redirectUri = args.redirectUri;
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
  getSecretName: getTodoistSecretName,
});
