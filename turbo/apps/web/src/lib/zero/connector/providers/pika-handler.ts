import { type ProviderHandler } from "../provider-types";

export const pikaHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Pika does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Pika does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "PIKA_TOKEN";
  },
};
