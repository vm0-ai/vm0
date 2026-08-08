import type { OpenIdAuthConnectorAuthProvider } from "../../types";
import {
  buildSteamOpenIdAuthorizationUrl,
  verifySteamOpenIdCallback,
} from "./openid";

export const steamProvider: OpenIdAuthConnectorAuthProvider<"steam"> = {
  grant: {
    kind: "openid-auth",
    buildAuthUrl: (args) => {
      return buildSteamOpenIdAuthorizationUrl({
        returnTo: args.returnTo,
        realm: args.realm,
      });
    },
    verifyCallback: async (args, signal: AbortSignal) => {
      const result = await verifySteamOpenIdCallback(
        {
          callbackParams: args.callbackParams,
          expectedReturnTo: args.expectedReturnTo,
          expectedRealm: args.expectedRealm,
        },
        signal,
      );
      return {
        outputs: {
          steamId: result.steamId,
        },
        scopes: [],
        userInfo: {
          id: result.steamId,
          username: result.steamId,
          email: null,
        },
      };
    },
  },
  access: { kind: "none" },
  revoke: { kind: "none" },
};
