import { type ProviderHandler } from "../provider-types";

export const snowflakeHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Snowflake does not support OAuth — use PAT auth");
  },
  exchangeCode() {
    throw new Error("Snowflake does not support OAuth — use PAT auth");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "SNOWFLAKE_PAT";
  },
};
