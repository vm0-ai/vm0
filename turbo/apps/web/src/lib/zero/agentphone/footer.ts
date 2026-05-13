import { eq } from "drizzle-orm";
import { getModelDisplayName } from "@vm0/core/model-display-name";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { ensureOrgModelPolicies } from "../model-policy/org-model-policy-service";
import { resolveDefaultAgentId } from "../resolve-default-agent";

export function formatAgentPhoneAuditLink(logsUrl: string): string {
  return `Audit: ${logsUrl}`;
}

function plainLabel(value: string | null | undefined): string | undefined {
  const label = value?.trim().replace(/\s+/gu, " ");
  return label ? label : undefined;
}

function displayLabel(row: {
  agentDisplayName: string | null;
  agentName: string | null;
  composeName: string;
}): string {
  return (
    plainLabel(row.agentDisplayName) ??
    plainLabel(row.agentName) ??
    plainLabel(row.composeName) ??
    "zero"
  );
}

async function resolveComposeLabel(
  composeId: string,
): Promise<string | undefined> {
  const [row] = await globalThis.services.db
    .select({
      agentDisplayName: zeroAgents.displayName,
      agentName: zeroAgents.name,
      composeName: agentComposes.name,
    })
    .from(agentComposes)
    .leftJoin(zeroAgents, eq(zeroAgents.id, agentComposes.id))
    .where(eq(agentComposes.id, composeId))
    .limit(1);

  return row ? displayLabel(row) : undefined;
}

async function resolveRespondedByLabel(
  orgId: string,
  composeId: string,
): Promise<string | undefined> {
  const orgDefaultComposeId = await resolveDefaultAgentId(orgId);
  if (!orgDefaultComposeId || composeId === orgDefaultComposeId) {
    return undefined;
  }

  const label = await resolveComposeLabel(composeId);
  return label ? `Responded by ${label}` : undefined;
}

async function resolveRunSelectedModel(
  runId: string,
): Promise<string | undefined> {
  const [row] = await globalThis.services.db
    .select({ selectedModel: zeroRuns.selectedModel })
    .from(zeroRuns)
    .where(eq(zeroRuns.id, runId))
    .limit(1);

  return row?.selectedModel ?? undefined;
}

async function resolveWorkspaceDefaultModel(
  orgId: string,
): Promise<string | undefined> {
  const policies = await ensureOrgModelPolicies(orgId);
  return (
    policies.find((policy) => {
      return policy.isDefault;
    })?.model ?? undefined
  );
}

async function resolveModelLabel(
  orgId: string,
  runId: string,
): Promise<string | undefined> {
  const selectedModel = await resolveRunSelectedModel(runId);
  const model = selectedModel ?? (await resolveWorkspaceDefaultModel(orgId));

  return model ? getModelDisplayName(model) : undefined;
}

export async function resolveAgentPhoneReplyFooterText(params: {
  orgId: string;
  runId: string;
  agentId: string;
}): Promise<string | undefined> {
  const [respondedBy, modelLabel] = await Promise.all([
    resolveRespondedByLabel(params.orgId, params.agentId),
    resolveModelLabel(params.orgId, params.runId),
  ]);

  const parts: string[] = [];
  if (respondedBy) parts.push(respondedBy);
  if (modelLabel) parts.push(modelLabel);

  return parts.length > 0 ? parts.join(" · ") : undefined;
}
