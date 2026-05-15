import { type ProviderHandler } from "../provider-types";

export const agoraHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Agora does not support OAuth — use REST credentials auth");
  },
  exchangeCode() {
    throw new Error("Agora does not support OAuth — use REST credentials auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "AGORA_CUSTOMER_SECRET";
  },
};
