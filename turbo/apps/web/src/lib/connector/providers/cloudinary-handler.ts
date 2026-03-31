import { type ProviderHandler } from "../provider-types";

export const cloudinaryHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Cloudinary does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Cloudinary does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "CLOUDINARY_TOKEN";
  },
};
