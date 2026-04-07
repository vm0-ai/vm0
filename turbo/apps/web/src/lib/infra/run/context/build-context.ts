import { expandEnvironmentFromCompose } from "../environment/expand-environment";
import type { ExecutionContext, ResumeSession } from "../types";
import type { ArtifactSnapshot } from "../../checkpoint/types";
import type { Firewalls } from "@vm0/core";

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
  memoryName?: string;
  volumeVersions?: Record<string, string>;
  environment?: Record<string, string>;
  userTimezone?: string;
  firewalls?: Firewalls;
  disallowedTools?: string[];
  tools?: string[];
  settings?: string;
  agentName?: string;
  debugNoMockClaude?: boolean;
  captureNetworkBodies?: boolean;
  continuedFromSessionId?: string;
  resumedFromCheckpointId?: string;
  resumeSession?: ResumeSession;
  resumeArtifact?: ArtifactSnapshot;
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
    memoryName: params.memoryName,
    volumeVersions: params.volumeVersions,
    environment,
    userTimezone: params.userTimezone,
    firewalls: params.firewalls,
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
    apiStartTime: Date.now(),
  };

  return { context };
}
