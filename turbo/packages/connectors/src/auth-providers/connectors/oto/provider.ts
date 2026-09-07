import type { RefreshTokenAccessProvider } from "../../types";
import { fetchOtoAccessToken } from "./api-token";

export const otoProvider = {
  access: {
    kind: "refresh-token",
    refresh: async (args, signal: AbortSignal) => {
      const token = await fetchOtoAccessToken(
        { refreshToken: args.inputs.refreshToken },
        signal,
      );
      return {
        outputs: {
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
        },
        expiresIn: token.expiresIn,
      };
    },
  } satisfies RefreshTokenAccessProvider<"oto", "api-token">,
};
