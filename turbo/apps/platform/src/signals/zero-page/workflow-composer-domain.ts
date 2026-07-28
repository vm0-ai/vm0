import type { ZeroWorkflowSummary } from "@vm0/api-contracts/contracts/zero-workflows";

export function findWorkflowQueryMatches(
  workflows: readonly ComposerSlashWorkflow[],
  query: string,
  substringSearchEnabled: boolean,
): readonly ComposerSlashWorkflow[] {
  const normalizedQuery = query.toLowerCase();
  const prefixMatches: ComposerSlashWorkflow[] = [];
  const substringMatches: ComposerSlashWorkflow[] = [];

  for (const workflow of workflows) {
    const normalizedName = workflow.name.toLowerCase();
    if (normalizedName.startsWith(normalizedQuery)) {
      prefixMatches.push(workflow);
    } else if (
      substringSearchEnabled &&
      normalizedName.includes(normalizedQuery)
    ) {
      substringMatches.push(workflow);
    }
  }

  return [...prefixMatches, ...substringMatches];
}

export interface SlashWorkflowRange {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

export interface ComposerSlashWorkflow {
  readonly name: string;
  readonly displayName: string | null;
  readonly description: string | null;
  readonly token: string;
}

export function findActiveSlashWorkflowRange(
  value: string,
  caretIndex: number,
): SlashWorkflowRange | null {
  if (caretIndex < 0 || caretIndex > value.length) {
    return null;
  }

  const beforeCaret = value.slice(0, caretIndex);
  const match = /(?:^|\s)\/([a-z0-9-]*)$/i.exec(beforeCaret);
  if (!match) {
    return null;
  }

  const query = match[1] ?? "";
  const slashOffset = match[0].lastIndexOf("/");
  const start = beforeCaret.length - match[0].length + slashOffset;
  return { start, end: caretIndex, query };
}

export function workflowTokenPattern(
  workflowNames: readonly string[],
): RegExp | null {
  if (workflowNames.length === 0) {
    return null;
  }

  const escaped = workflowNames.map((name) => {
    return name.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  });
  return new RegExp(`(?:^|\\s)/(?:${escaped.join("|")})(?=$|\\s)`, "g");
}

export function buildComposerSlashWorkflows({
  agentId,
  workflows,
}: {
  readonly agentId: string | null | undefined;
  readonly workflows: readonly ZeroWorkflowSummary[];
}): readonly ComposerSlashWorkflow[] {
  if (!agentId) {
    return [];
  }

  return workflows
    .filter((workflow) => {
      return workflow.agentId === agentId;
    })
    .map((workflow) => {
      const name = workflow.name;
      return {
        name,
        displayName: workflow.displayName,
        description: workflow.description,
        token: `/${name}`,
      };
    });
}
