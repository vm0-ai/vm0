import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const bentoml = {
  bentoml: {
    label: "BentoML",
    category: "data-automation-infrastructure",
    generation: ["text"],
    tags: ["bentocloud", "model-serving", "mlops", "inference"],
    environmentMapping: {
      BENTO_CLOUD_API_KEY: "$secrets.BENTO_CLOUD_API_KEY",
      BENTO_CLOUD_API_ENDPOINT: "$vars.BENTO_CLOUD_API_ENDPOINT",
    },
    helpText:
      "Connect your BentoCloud account to manage BentoML deployments and call protected deployment endpoints",
    authMethods: {
      "api-token": {
        featureFlag: FeatureSwitchKey.BentomlConnector,
        label: "BentoCloud API Token",
        helpText:
          "1. Log in to [BentoCloud](https://cloud.bentoml.com)\n2. Open your profile menu, then go to **API Tokens**\n3. Create a Personal or Organization API token with the access your workflow needs\n4. Copy the token and enter your organization endpoint, for example `https://your-org.cloud.bentoml.com`",
        secrets: {
          BENTO_CLOUD_API_KEY: {
            label: "API Token",
            required: true,
            placeholder: "cur7h...",
          },
          BENTO_CLOUD_API_ENDPOINT: {
            label: "BentoCloud Endpoint",
            required: true,
            placeholder: "https://your-org.cloud.bentoml.com",
            type: "variable",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
