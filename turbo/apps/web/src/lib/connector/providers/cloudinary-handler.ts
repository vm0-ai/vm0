import { type ProviderHandler } from "../provider-types";

export const cloudinaryHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Cloudinary does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Cloudinary does not support OAuth — use API token auth");
  },
  getClientId: () => undefined,
  getClientSecret: () => undefined,
  getSecretName: () => "CLOUDINARY_TOKEN",
};
