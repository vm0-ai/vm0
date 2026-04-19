import { type ProviderHandler } from "../provider-types";

export const wandbHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error(
      "Weights & Biases does not support OAuth — use API token auth",
    );
  },
  exchangeCode() {
    throw new Error(
      "Weights & Biases does not support OAuth — use API token auth",
    );
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "WANDB_TOKEN";
  },
};
