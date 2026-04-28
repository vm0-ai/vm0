import { expandEnvironmentFromCompose } from "../environment/expand-environment";
import type {
  ContextArtifact,
  ExecutionContext,
  ResumeSession,
} from "../types";
import type { AdditionalVolume } from "../../storage/types";
import type {
  Firewalls,
  NetworkPolicies,
} from "@vm0/connectors/firewall-types";

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
  artifacts?: ContextArtifact[];
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
  modelUsageProvider?: string;
  continuedFromSessionId?: string;
  resumedFromCheckpointId?: string;
  resumeSession?: ResumeSession;
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
    artifacts: params.artifacts,
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
    agentName: params.agentName,
    resumedFromCheckpointId: params.resumedFromCheckpointId,
    continuedFromSessionId: params.continuedFromSessionId,
    debugNoMockClaude: params.debugNoMockClaude,
    captureNetworkBodies: params.captureNetworkBodies,
    billableFirewalls: params.billableFirewalls,
    modelUsageProvider: params.modelUsageProvider,
    apiStartTime: params.apiStartTime,
  };

  return { context };
}
