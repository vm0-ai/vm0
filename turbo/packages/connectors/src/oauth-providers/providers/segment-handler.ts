import { type ProviderHandler } from "../provider-types";

export const segmentHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error(
      "Segment does not support OAuth — use Public API token auth",
    );
  },
  exchangeCode() {
    throw new Error(
      "Segment does not support OAuth — use Public API token auth",
    );
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "SEGMENT_TOKEN";
  },
};
