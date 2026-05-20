import { type ProviderHandler } from "../provider-types";
import {
  buildBase44AuthorizationUrl,
  exchangeBase44Code,
  getBase44RefreshSecretName,
  getBase44SecretName,
  refreshBase44Token,
} from "./base44";

export const base44Handler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Base44 requires dynamic OAuth authorization arguments");
  },
  buildAuthUrlWithArgs(args) {
    return buildBase44AuthorizationUrl({
      redirectUri: args.redirectUri,
      state: args.state,
    });
  },
  exchangeCode() {
    throw new Error("Base44 requires dynamic OAuth exchange arguments");
  },
  exchangeCodeWithArgs(args) {
    return exchangeBase44Code({
      code: args.code,
      redirectUri: args.redirectUri,
      codeVerifier: args.codeVerifier,
      oauthContext: args.oauthContext,
    });
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: getBase44SecretName,
  getRefreshSecretName: getBase44RefreshSecretName,
  refreshTokenWithArgs(args) {
    return refreshBase44Token(args.refreshToken);
  },
};
