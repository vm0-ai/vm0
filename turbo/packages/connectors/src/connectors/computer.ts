import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const computer = {
  computer: {
    label: "Computer",
    category: "engineering-team-execution",
    helpText:
      "Expose local services to remote sandboxes via authenticated ngrok tunnels",
    authMethods: {
      api: {
        featureFlag: FeatureSwitchKey.ComputerConnector,
        label: "API",
        helpText: "Server-provisioned ngrok tunnel credentials.",
        grant: { kind: "managed" },
        access: {
          kind: "managed",
          outputs: {
            COMPUTER_CONNECTOR_BRIDGE_TOKEN:
              "$secrets.COMPUTER_CONNECTOR_BRIDGE_TOKEN",
            COMPUTER_CONNECTOR_DOMAIN: "$secrets.COMPUTER_CONNECTOR_DOMAIN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api",
  },
} as const satisfies Record<string, ConnectorConfig>;
