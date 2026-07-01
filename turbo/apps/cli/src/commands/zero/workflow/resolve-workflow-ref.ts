import { listWorkflows } from "../../../lib/api";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKFLOW_NAME_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

export interface WorkflowRefOptions {
  readonly agent?: string;
}

function isWorkflowName(ref: string): boolean {
  return ref.length >= 2 && ref.length <= 64 && WORKFLOW_NAME_RE.test(ref);
}

export async function resolveWorkflowRef(
  ref: string,
  options: WorkflowRefOptions,
): Promise<string> {
  if (UUID_RE.test(ref)) {
    return ref;
  }

  if (!isWorkflowName(ref)) {
    throw new Error(
      `Invalid workflow ref: "${ref}". Use a workflow ID or a slug name like "tell-a-joke"`,
    );
  }

  const agentId = options.agent ?? process.env.ZERO_AGENT_ID;
  if (!agentId) {
    throw new Error(
      "Workflow name refs require an agent scope. Pass --agent <agent-id>, set ZERO_AGENT_ID, or use a workflow ID",
    );
  }
  if (!UUID_RE.test(agentId)) {
    throw new Error(
      `Invalid agent ID: "${agentId}". Pass an agent UUID for --agent or use a workflow ID`,
    );
  }

  const workflows = await listWorkflows({ agentId });
  const matches = workflows.filter((workflow) => {
    return workflow.name === ref;
  });
  if (matches.length === 0) {
    throw new Error(
      `Workflow not found: "${ref}" under agent "${agentId}". Check the name and agent, or use the workflow ID`,
    );
  }

  const winners = matches.filter((workflow) => {
    return workflow.shadowedBy == null;
  });
  if (winners.length !== 1) {
    throw new Error(
      `Workflow name "${ref}" did not resolve to exactly one runtime winner under agent "${agentId}". Use the workflow ID`,
    );
  }
  return winners[0]!.id;
}
