import type { RefreshTokenAccessProvider } from "../../types";
import { refreshReckonAccessToken } from "./api-token";

export const reckonProvider = {
  access: {
    kind: "refresh-token",
    refresh: async (args, signal: AbortSignal) => {
      const token = await refreshReckonAccessToken(
        {
          clientId: args.inputs.clientId,
          clientSecret: args.inputs.clientSecret,
          redirectUri: args.inputs.redirectUri,
          refreshToken: args.inputs.refreshToken,
        },
        signal,
      );
      return {
        outputs: {
          accessToken: token.accessToken,
          ...(token.refreshToken === undefined
            ? {}
            : { refreshToken: token.refreshToken }),
        },
        ...(token.expiresIn === undefined
          ? {}
          : { expiresIn: token.expiresIn }),
      };
    },
  } satisfies RefreshTokenAccessProvider<"reckon", "oauth-refresh-token">,
};
