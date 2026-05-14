import { type ProviderHandler } from "../provider-types";

export const ironcladHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Ironclad does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Ironclad does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "IRONCLAD_API_KEY";
  },
};
