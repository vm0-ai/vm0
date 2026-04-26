import { FeatureSwitchKey } from "../feature-switch-key";
import type { ConnectorConfig } from "../connectors";

export const computer = {
  computer: {
    label: "Computer",
    category: "engineering-team-execution",
    environmentMapping: {
      COMPUTER_CONNECTOR_BRIDGE_TOKEN:
        "$secrets.COMPUTER_CONNECTOR_BRIDGE_TOKEN",
      COMPUTER_CONNECTOR_DOMAIN: "$secrets.COMPUTER_CONNECTOR_DOMAIN",
    },
    featureFlag: FeatureSwitchKey.ComputerConnector,
    helpText:
      "Expose local services to remote sandboxes via authenticated ngrok tunnels",
    authMethods: {
      api: {
        label: "API",
        helpText: "Server-provisioned ngrok tunnel credentials.",
        secrets: {
          COMPUTER_CONNECTOR_BRIDGE_TOKEN: {
            label: "Bridge Token",
            required: true,
          },
          COMPUTER_CONNECTOR_DOMAIN_ID: {
            label: "Domain ID",
            required: true,
          },
          COMPUTER_CONNECTOR_DOMAIN: {
            label: "Tunnel Domain",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "api",
  },
} as const satisfies Record<string, ConnectorConfig>;
