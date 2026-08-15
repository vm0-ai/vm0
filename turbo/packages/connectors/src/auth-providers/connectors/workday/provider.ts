import type { RefreshTokenAccessProvider } from "../../types";
import { refreshWorkdayAccessToken } from "./api-token";

export const workdayProvider = {
  access: {
    kind: "refresh-token",
    refresh: async (args, signal: AbortSignal) => {
      const token = await refreshWorkdayAccessToken(
        {
          host: args.inputs.host,
          tenant: args.inputs.tenant,
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
  } satisfies RefreshTokenAccessProvider<"workday", "api-token">,
};
