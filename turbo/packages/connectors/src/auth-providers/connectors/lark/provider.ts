import type { RefreshTokenAccessProvider } from "../../types";
import { fetchLarkTenantAccessToken } from "./api-token";

function createLarkAccessProvider(): RefreshTokenAccessProvider<
  "lark",
  "api-token"
> {
  return {
    kind: "refresh-token",
    refresh: async (args) => {
      const token = await fetchLarkTenantAccessToken({
        appId: args.inputs.appId,
        appSecret: args.inputs.appSecret,
        signal: args.signal,
      });
      return {
        outputs: {
          accessToken: token.accessToken,
        },
        expiresIn: token.expiresIn,
      };
    },
  };
}

export const larkProvider = {
  access: createLarkAccessProvider(),
} as const satisfies {
  readonly access: RefreshTokenAccessProvider<"lark", "api-token">;
};
