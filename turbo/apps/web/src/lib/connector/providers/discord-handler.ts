import { type ProviderHandler } from "../provider-types";
import {
  buildDiscordAuthorizationUrl,
  exchangeDiscordCode,
  getDiscordSecretName,
} from "./discord";

export const discordHandler: ProviderHandler = {
  buildAuthUrl: buildDiscordAuthorizationUrl,
  async exchangeCode(clientId, clientSecret, code, redirectUri) {
    const result = await exchangeDiscordCode(
      clientId,
      clientSecret,
      code,
      redirectUri,
    );
    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
      scopes: result.scopes,
      userInfo: {
        id: result.userInfo.id,
        username: result.userInfo.username,
        email: result.userInfo.email,
      },
    };
  },
  getClientId: (e) => e.DISCORD_OAUTH_CLIENT_ID,
  getClientSecret: (e) => e.DISCORD_OAUTH_CLIENT_SECRET,
  getSecretName: getDiscordSecretName,
  getRefreshSecretName: () => "DISCORD_REFRESH_TOKEN",
};
