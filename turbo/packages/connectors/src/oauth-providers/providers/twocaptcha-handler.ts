import { type ProviderHandler } from "../provider-types";

export const twocaptchaHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("2Captcha does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("2Captcha does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "TWOCAPTCHA_TOKEN";
  },
};
