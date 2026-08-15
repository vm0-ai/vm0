import type { RefreshTokenAccessProvider } from "../../types";
import { refreshNetSuiteAccessToken } from "./api-token";

export const netsuiteProvider = {
  access: {
    kind: "refresh-token",
    refresh: async (args, signal: AbortSignal) => {
      const token = await refreshNetSuiteAccessToken(
        {
          accountSubdomain: args.inputs.accountSubdomain,
          clientId: args.inputs.clientId,
          clientSecret: args.inputs.clientSecret,
          refreshToken: args.inputs.refreshToken,
        },
        signal,
      );
      return {
        outputs: {
          accessToken: token.accessToken,
          ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
        },
        ...(token.expiresIn === undefined
          ? {}
          : { expiresIn: token.expiresIn }),
      };
    },
  } satisfies RefreshTokenAccessProvider<"netsuite", "api-token">,
};
