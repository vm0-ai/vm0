import type { AuthCodeConnectorAuthProvider } from "../../types";
import { buildCopperAuthorizationUrl, exchangeCopperCode } from "./oauth";

export const copperProvider: AuthCodeConnectorAuthProvider<"copper", "oauth"> =
  {
    grant: {
      kind: "auth-code",
      buildAuthUrl: (args) => {
        return buildCopperAuthorizationUrl(
          args.authCodeGrant,
          args.authClient.clientId,
          args.redirectUri,
          args.state,
        );
      },
      exchangeCode: async (args) => {
        const result = await exchangeCopperCode({
          grant: args.authCodeGrant,
          clientId: args.authClient.clientId,
          clientSecret: args.authClient.clientSecret,
          code: args.code,
          redirectUri: args.redirectUri,
        });
        return {
          outputs: { accessToken: result.accessToken },
          scopes: result.scopes,
          userInfo: result.userInfo,
        };
      },
    },
    access: { kind: "none" },
    revoke: { kind: "none" },
  };
