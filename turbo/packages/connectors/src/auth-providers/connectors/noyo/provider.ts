import type { RefreshTokenAccessProvider } from "../../types";
import { fetchNoyoAccessToken } from "./api-token";

export const noyoProvider = {
  access: {
    kind: "refresh-token",
    refresh: async (args, signal: AbortSignal) => {
      const token = await fetchNoyoAccessToken(
        {
          clientId: args.inputs.clientId,
          clientSecret: args.inputs.clientSecret,
        },
        signal,
      );
      return {
        outputs: { accessToken: token.accessToken },
        expiresIn: token.expiresIn,
      };
    },
  } satisfies RefreshTokenAccessProvider<"noyo", "api-token">,
};
