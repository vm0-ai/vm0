import {
  CONNECTOR_TYPES,
  type ConnectorConfig,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import { getConnectorGenerationTypes } from "@vm0/connectors/connector-utils";
import type { GenerationType } from "./lister";

function toConnectorGenerationType(
  generationType: GenerationType,
): string | null {
  switch (generationType) {
    case "voice":
    case "music":
      return "audio";
    case "dashboard-design":
    case "docs-design":
    case "mobile-app-design":
    case "poster":
    case "report":
      return null;
    default:
      return generationType;
  }
}

function isConnectorType(value: string): value is ConnectorType {
  return value in CONNECTOR_TYPES;
}

interface ConnectorGuidance {
  readonly type: ConnectorType;
  readonly label: string;
  readonly supportsGenerationType: boolean;
}

function resolveConnector(
  provider: string,
  generationType: GenerationType,
): ConnectorGuidance | null {
  if (!isConnectorType(provider)) return null;
  const config: ConnectorConfig = CONNECTOR_TYPES[provider];
  const connectorGenerationType = toConnectorGenerationType(generationType);
  const supports =
    connectorGenerationType !== null &&
    getConnectorGenerationTypes(provider).some((entry) => {
      return entry === connectorGenerationType;
    });
  return {
    type: provider,
    label: config.label,
    supportsGenerationType: supports,
  };
}

export function printConnectorGuidance(
  generationType: GenerationType,
  provider: string,
): void {
  const guidance = resolveConnector(provider, generationType);

  if (!guidance) {
    console.log(`Provider "${provider}" is not a known connector.`);
    console.log("");
    console.log(
      `Run "zero generate ${generationType}" to see every provider available for this generation type.`,
    );
    return;
  }

  if (!guidance.supportsGenerationType) {
    console.log(
      `${guidance.label} (${guidance.type}) does not advertise ${generationType} generation.`,
    );
    console.log("");
    console.log(
      `Run "zero generate ${generationType}" to see every provider that supports this generation type.`,
    );
    return;
  }

  console.log(
    `${guidance.label} (${guidance.type}) handles ${generationType} generation through its own connector skill, not through "zero generate".`,
  );
  console.log("");
  console.log(`Next steps:`);
  console.log(`  - Use the "${guidance.type}" skill in this session.`);
  console.log(
    `  - Or call the connector directly via its documented endpoints.`,
  );
  console.log("");
  console.log(
    `Run "zero connector status ${guidance.type}" to verify the connector is connected and authorized for the current agent.`,
  );
}
