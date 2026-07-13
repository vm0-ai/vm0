import type { RefreshTokenAccessProvider } from "../../types";
import { fetchRampAccessToken } from "./api-token";

export const rampProvider = {
  access: {
    kind: "refresh-token",
    refresh: async (args) => {
      const token = await fetchRampAccessToken({
        clientId: args.inputs.clientId,
        clientSecret: args.inputs.clientSecret,
        scope: args.inputs.scope,
        signal: args.signal,
      });
      return {
        outputs: { accessToken: token.accessToken },
        expiresIn: token.expiresIn,
      };
    },
  } satisfies RefreshTokenAccessProvider<"ramp", "api-token">,
};
