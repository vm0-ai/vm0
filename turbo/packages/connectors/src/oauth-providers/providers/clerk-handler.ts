import { type ProviderHandler } from "../provider-types";

export const clerkHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Clerk does not support OAuth — use API token auth");
  },
  exchangeCode() {
    throw new Error("Clerk does not support OAuth — use API token auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "CLERK_TOKEN";
  },
};
