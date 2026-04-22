import { expandEnvironmentFromCompose } from "../environment/expand-environment";
import type { ExecutionContext, ResumeSession } from "../types";
import type { ArtifactSnapshot } from "../../checkpoint/types";
import {
  AUTO_MEMORY_MOUNT_PATH,
  type AdditionalArtifact,
  type AdditionalVolume,
} from "../../storage/types";
import type { Firewalls, NetworkPolicies } from "@vm0/core";

interface BuildInfraContextParams {
  runId: string;
  userId: string;
  orgId: string;
  agentComposeVersionId: string;
  agentCompose: unknown;
  prompt: string;
  sandboxToken: string;
  appendSystemPrompt?: string;
  vars?: Record<string, string>;
  secrets?: Record<string, string>;
  secretConnectorMap?: Record<string, string>;
  artifactName?: string;
  artifactVersion?: string;
  artifacts?: AdditionalArtifact[];
  memoryName?: string;
  volumeVersions?: Record<string, string>;
  additionalVolumes?: AdditionalVolume[];
  environment?: Record<string, string>;
  userTimezone?: string;
  firewalls?: Firewalls;
  networkPolicies?: NetworkPolicies;
  disallowedTools?: string[];
  tools?: string[];
  settings?: string;
  agentName?: string;
  debugNoMockClaude?: boolean;
  captureNetworkBodies?: boolean;
  billableFirewalls: string[];
  continuedFromSessionId?: string;
  resumedFromCheckpointId?: string;
  resumeSession?: ResumeSession;
  resumeArtifact?: ArtifactSnapshot;
  apiStartTime: number;
}

interface BuildInfraContextResult {
  context: ExecutionContext;
}

/**
 * Build an ExecutionContext from caller-provided params for the CLI path.
 *
 * This is the infra counterpart to buildZeroExecutionContext — it assembles
 * context without any DB queries, model provider resolution, or connector
 * secret resolution. All data comes directly from the caller.
 */
export function buildInfraExecutionContext(
  params: BuildInfraContextParams,
): BuildInfraContextResult {
  // Use pre-resolved environment if provided, otherwise expand from compose
  const environment =
    params.environment ??
    expandEnvironmentFromCompose(
      params.agentCompose,
      params.vars,
      params.secrets,
    ).environment;

  // Fold memory into artifacts[] so downstream treats memory as just another
  // artifact entry (#10602). memoryName stays on the context for session-row
  // bookkeeping (agent_sessions.memory_name) and runner wire compat.
  const artifacts: AdditionalArtifact[] | undefined = params.memoryName
    ? [
        ...(params.artifacts ?? []),
        { name: params.memoryName, mountPath: AUTO_MEMORY_MOUNT_PATH },
      ]
    : params.artifacts;

  const context: ExecutionContext = {
    runId: params.runId,
    userId: params.userId,
    orgId: params.orgId,
    agentComposeVersionId: params.agentComposeVersionId,
    agentCompose: params.agentCompose,
    prompt: params.prompt,
    appendSystemPrompt: params.appendSystemPrompt,
    vars: params.vars,
    secrets: params.secrets,
    secretConnectorMap: params.secretConnectorMap,
    sandboxToken: params.sandboxToken,
    artifactName: params.artifactName,
    artifactVersion: params.artifactVersion,
    artifacts,
    memoryName: params.memoryName,
    volumeVersions: params.volumeVersions,
    additionalVolumes: params.additionalVolumes,
    environment,
    userTimezone: params.userTimezone,
    firewalls: params.firewalls,
    networkPolicies: params.networkPolicies,
    disallowedTools: params.disallowedTools,
    tools: params.tools,
    settings: params.settings,
    resumeSession: params.resumeSession,
    resumeArtifact: params.resumeArtifact,
    agentName: params.agentName,
    resumedFromCheckpointId: params.resumedFromCheckpointId,
    continuedFromSessionId: params.continuedFromSessionId,
    debugNoMockClaude: params.debugNoMockClaude,
    captureNetworkBodies: params.captureNetworkBodies,
    billableFirewalls: params.billableFirewalls,
    apiStartTime: params.apiStartTime,
  };

  return { context };
}
