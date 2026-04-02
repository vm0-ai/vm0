import { type ProviderHandler } from "../provider-types";

export const elevenlabsHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("ElevenLabs does not support OAuth — use API key auth");
  },
  exchangeCode() {
    throw new Error("ElevenLabs does not support OAuth — use API key auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "ELEVENLABS_TOKEN";
  },
};
