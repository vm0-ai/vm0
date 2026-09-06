import type { RefreshTokenAccessProvider } from "../../types";
import { fetchProcountorAccessToken } from "./api-token";

export const procountorProvider = {
  access: {
    kind: "refresh-token",
    refresh: async (args, signal: AbortSignal) => {
      const token = await fetchProcountorAccessToken(
        {
          apiKey: args.inputs.apiKey,
          clientId: args.inputs.clientId,
          clientSecret: args.inputs.clientSecret,
          redirectUri: args.inputs.redirectUri,
        },
        signal,
      );
      return {
        outputs: { accessToken: token.accessToken },
        expiresIn: token.expiresIn,
      };
    },
  } satisfies RefreshTokenAccessProvider<"procountor", "api-token">,
};
