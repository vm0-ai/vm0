import { listWorkflows } from "../../../lib/api";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuidRef(ref: string): boolean {
  return UUID_RE.test(ref);
}

function workflowScopeLabel(agentRef: string): string {
  return isUuidRef(agentRef) ? `agent ${agentRef}` : `agent "${agentRef}"`;
}

export async function resolveWorkflowRef(
  ref: string,
  options: { agent?: string } = {},
): Promise<string> {
  if (isUuidRef(ref)) {
    return ref;
  }

  const agentRef = options.agent ?? process.env.ZERO_AGENT_ID;
  if (!agentRef) {
    throw new Error(
      `Workflow "${ref}" is a name. Provide --agent <agent-id-or-name>, set ZERO_AGENT_ID, or use the workflow ID.`,
    );
  }

  const agentIsUuid = isUuidRef(agentRef);
  const workflows = await listWorkflows(
    agentIsUuid ? { agentId: agentRef } : {},
  );
  const matches = workflows.filter((workflow) => {
    if (workflow.name !== ref) {
      return false;
    }
    return agentIsUuid
      ? workflow.agentId === agentRef
      : workflow.agentName === agentRef;
  });

  if (matches.length === 0) {
    throw new Error(
      `Workflow "${ref}" not found under ${workflowScopeLabel(agentRef)}. Use a workflow ID or check zero workflow list.`,
    );
  }
  if (matches.length > 1) {
    const ids = matches
      .map((workflow) => {
        return workflow.id;
      })
      .join(", ");
    throw new Error(
      `Workflow "${ref}" is ambiguous under ${workflowScopeLabel(agentRef)} (${ids}). Use the workflow ID.`,
    );
  }

  return matches[0]!.id;
}
