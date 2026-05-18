import { type ProviderHandler } from "../provider-types";

export const openweatherHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("OpenWeather does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("OpenWeather does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "OPENWEATHER_TOKEN";
  },
};
