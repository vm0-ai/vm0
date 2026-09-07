import type { ConnectorRuntimeTargetRegistration } from "@okouai/api-contracts/contracts/runners";

export interface AgentRunConnectorDiagnosticRegistrationPayload {
  readonly version: 1;
  readonly targets: readonly ConnectorRuntimeTargetRegistration[];
}
