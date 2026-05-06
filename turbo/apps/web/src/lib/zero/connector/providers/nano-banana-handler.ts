import { type ProviderHandler } from "../provider-types";

export const nanoBananaHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Nano Banana is a platform connector — no OAuth required");
  },
  exchangeCode() {
    throw new Error("Nano Banana is a platform connector — no OAuth required");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "NANO_BANANA_TOKEN";
  },
};
