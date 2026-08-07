import type { RefreshTokenAccessProvider } from "../../types";
import { fetchLogtoAccessToken } from "./m2m";

export const logtoProvider = {
  access: {
    kind: "refresh-token",
    refresh: async (args) => {
      const token = await fetchLogtoAccessToken({
        tenantId: args.inputs.tenantId,
        appId: args.inputs.appId,
        appSecret: args.inputs.appSecret,
        signal: args.signal,
      });
      return {
        outputs: { accessToken: token.accessToken },
        expiresIn: token.expiresIn,
      };
    },
  } satisfies RefreshTokenAccessProvider<"logto", "m2m">,
};
