import type { AuthCodeConnectorAuthProvider } from "../../auth-providers/provider-types";
import {
  buildTodoistAuthorizationUrl,
  exchangeTodoistCode,
  getTodoistSecretName,
} from "./todoist";
export const todoistProvider: AuthCodeConnectorAuthProvider<"todoist"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args;
      return buildTodoistAuthorizationUrl(
        clientId,
        args.redirectUri,
        args.state,
      );
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
  },
  access: {
    kind: "none",
    getAccessSecretName: getTodoistSecretName,
  },
  revoke: { kind: "none" },
};
