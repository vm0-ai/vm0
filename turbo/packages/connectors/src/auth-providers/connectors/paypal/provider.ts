import type { RefreshTokenAccessProvider } from "../../types";
import { fetchPayPalAccessToken } from "./api-token";

export const paypalProvider = {
  access: {
    kind: "refresh-token",
    refresh: async (args, signal: AbortSignal) => {
      const token = await fetchPayPalAccessToken(
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
  } satisfies RefreshTokenAccessProvider<"paypal", "api-token">,
};
