import type { ContextArtifact, PersistedStorageMount } from "../types";
import type { JsonValue } from "./shared";

export type AgentRunVars = JsonValue;
export type AgentRunSecretNames = string[];
export type AgentRunAdditionalVolumes = Array<{
  name: string;
  version?: string;
  mountPath: string;
  system?: boolean;
}>;
export type AgentRunResult = JsonValue;
export type AgentSessionArtifacts = ContextArtifact[];
export type AgentRunStorageMounts = PersistedStorageMount[];
export type AgentSessionStorageMounts = PersistedStorageMount[];
