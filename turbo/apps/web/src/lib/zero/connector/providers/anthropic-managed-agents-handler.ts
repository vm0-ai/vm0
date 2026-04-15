import { type ProviderHandler } from "../provider-types";

export const anthropicManagedAgentsHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error(
      "Anthropic Managed Agents does not support OAuth — use API key auth",
    );
  },
  exchangeCode() {
    throw new Error(
      "Anthropic Managed Agents does not support OAuth — use API key auth",
    );
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "ANTHROPIC_MANAGED_AGENTS_TOKEN";
  },
};
