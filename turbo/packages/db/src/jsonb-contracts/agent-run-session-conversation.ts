import type { PersistedStorageMount } from "../types";
import type { JsonValue } from "./shared";

export type AgentRunVars = JsonValue;
export type AgentRunSecretNames = string[];
export type AgentRunLaunchSnapshot = {
  schemaVersion: 1;
  framework: "claude-code" | "codex" | "pi";
  runnerProfile: string;
};
export interface AgentRunOfficialWorkflowDefinitionProvenance {
  readonly name: string;
  readonly revision: string;
  readonly artifact: {
    readonly orgId: string;
    readonly userId: string;
    readonly storageName: string;
    readonly storageId: string;
    readonly storageVersion: string;
  };
}
export interface AgentRunOfficialWorkflowProvenance {
  readonly schemaVersion: 1;
  readonly definitions: readonly AgentRunOfficialWorkflowDefinitionProvenance[];
}
export type AgentRunResult = JsonValue;
export type AgentRunStorageMounts = PersistedStorageMount[];
export type AgentSessionStorageMounts = PersistedStorageMount[];
