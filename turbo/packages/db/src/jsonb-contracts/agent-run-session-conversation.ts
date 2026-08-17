import type { PersistedStorageMount } from "../types";
import type { JsonValue } from "./shared";

export type AgentRunVars = JsonValue;
export type AgentRunSecretNames = string[];
export type AgentRunLaunchSnapshot = {
  schemaVersion: 1;
  framework: "claude-code" | "codex" | "pi";
  runnerProfile: string;
};
export type AgentRunResult = JsonValue;
export type AgentRunStorageMounts = PersistedStorageMount[];
export type AgentSessionStorageMounts = PersistedStorageMount[];
