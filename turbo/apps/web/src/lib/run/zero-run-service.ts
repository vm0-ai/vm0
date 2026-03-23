import { type TriggerSource, orgTierSchema } from "@vm0/core";
import { getOrgData } from "../org/org-cache-service";
import { buildAgentIdentityPrompt } from "../agent-identity";
import { validateAgentSession } from "./run-service";
import { createRun, resolveByComposeId } from "./run-service";
import type { CreateRunResult } from "./run-service";

/**
 * Params for non-CLI callers (platform UI + integrations).
 *
 * Key differences from StartCliRunParams:
 * - composeId is always required (all non-CLI callers know the compose)
 * - Only supports composeId + sessionId resolution (no checkpointId, agentComposeVersionId)
 * - No callerOrgId cross-org check (non-CLI callers are already org-scoped)
 */
export interface StartZeroRunParams {
  userId: string;
  prompt: string;
  composeId: string;

  // Optional — compose resolution
  sessionId?: string;

  // Optional — forwarded to createRun
  appendSystemPrompt?: string;
  disallowedTools?: string[];
  tools?: string[];
  settings?: string;
  conversationId?: string;
  vars?: Record<string, string>;
  secrets?: Record<string, string>;
  artifactName?: string;
  artifactVersion?: string;
  memoryName?: string;
  volumeVersions?: Record<string, string>;
  scheduleId?: string;
  callbacks?: Array<{ url: string; secret: string; payload: unknown }>;
  modelProvider?: string;
  triggerSource?: TriggerSource;
  debugNoMockClaude?: boolean;
  checkEnv?: boolean;
}

/**
 * Run entry point for platform UI and integrations (non-CLI callers).
 *
 * Simpler than startCliRun(): only supports composeId + sessionId resolution,
 * no cross-org check. Resolves compose version + org context internally,
 * injects agent identity, then delegates to createRun().
 *
 * Defaults artifactName to "artifact" when not provided (integration callers
 * always use the default artifact).
 *
 * @throws NotFoundError - compose/session not found
 * @throws BadRequestError - compose has no versions
 * @throws ForbiddenError - user cannot access compose
 * @throws Error - dispatch failure
 */
export async function startZeroRun(
  params: StartZeroRunParams,
): Promise<CreateRunResult> {
  // 1. Resolve compose version: sessionId → resolveBySession, else composeId
  let resolved;
  if (params.sessionId) {
    const sessionData = await validateAgentSession(
      params.sessionId,
      params.userId,
    );
    resolved = await resolveByComposeId(sessionData.agentComposeId);
  } else {
    resolved = await resolveByComposeId(params.composeId);
  }

  // 2. Resolve org context
  const orgData = await getOrgData(resolved.orgId);
  const orgTier = orgTierSchema.parse(orgData.tier);

  // 3. Inject agent identity into appendSystemPrompt
  let { appendSystemPrompt } = params;
  if (resolved.composeId) {
    const identity = await buildAgentIdentityPrompt(resolved.composeId);
    if (identity) {
      appendSystemPrompt = appendSystemPrompt
        ? `${identity}\n\n${appendSystemPrompt}`
        : identity;
    }
  }

  // 4. Delegate to createRun with fully resolved params
  return createRun({
    userId: params.userId,
    agentComposeVersionId: resolved.agentComposeVersionId,
    prompt: params.prompt,
    appendSystemPrompt,
    disallowedTools: params.disallowedTools,
    tools: params.tools,
    settings: params.settings,
    composeId: resolved.composeId,
    sessionId: params.sessionId,
    conversationId: params.conversationId,
    vars: params.vars,
    secrets: params.secrets,
    artifactName: params.artifactName ?? "artifact",
    artifactVersion: params.artifactVersion,
    memoryName: params.memoryName,
    volumeVersions: params.volumeVersions,
    scheduleId: params.scheduleId,
    callbacks: params.callbacks,
    agentName: resolved.agentName,
    modelProvider: params.modelProvider,
    triggerSource: params.triggerSource,
    debugNoMockClaude: params.debugNoMockClaude,
    checkEnv: params.checkEnv,
    orgSlug: orgData.slug,
    orgId: resolved.orgId,
    orgTier,
  });
}
