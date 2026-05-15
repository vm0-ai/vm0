import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const computer = {
  computer: {
    label: "Computer",
    category: "engineering-team-execution",
    environmentMapping: {
      COMPUTER_CONNECTOR_BRIDGE_TOKEN:
        "$secrets.COMPUTER_CONNECTOR_BRIDGE_TOKEN",
      COMPUTER_CONNECTOR_DOMAIN: "$secrets.COMPUTER_CONNECTOR_DOMAIN",
    },
    helpText:
      "Expose local services to remote sandboxes via authenticated ngrok tunnels",
    authMethods: {
      api: {
        featureFlag: FeatureSwitchKey.ComputerConnector,
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
