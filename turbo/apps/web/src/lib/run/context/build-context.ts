import { expandEnvironmentFromCompose } from "../environment/expand-environment";
import type { ExecutionContext } from "../types";

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
  artifactName?: string;
  artifactVersion?: string;
  memoryName?: string;
  volumeVersions?: Record<string, string>;
  disallowedTools?: string[];
  tools?: string[];
  settings?: string;
  agentName?: string;
  debugNoMockClaude?: boolean;
  continuedFromSessionId?: string;
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
  const { environment } = expandEnvironmentFromCompose(
    params.agentCompose,
    params.vars,
    params.secrets,
  );

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
    sandboxToken: params.sandboxToken,
    artifactName: params.artifactName,
    artifactVersion: params.artifactVersion,
    memoryName: params.memoryName,
    volumeVersions: params.volumeVersions,
    environment,
    disallowedTools: params.disallowedTools,
    tools: params.tools,
    settings: params.settings,
    agentName: params.agentName,
    debugNoMockClaude: params.debugNoMockClaude,
    continuedFromSessionId: params.continuedFromSessionId,
    apiStartTime: Date.now(),
  };

  return { context };
}
