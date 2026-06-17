import { command, computed, state } from "ccstate";
import {
  zeroWorkflowsCollectionContract,
  zeroWorkflowsDetailContract,
  type ZeroWorkflowAgentSummary,
  type ZeroWorkflowDetailResponse,
  type ZeroWorkflowSummary,
} from "@vm0/api-contracts/contracts/zero-workflows";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";

export type WorkflowAttachmentFilter = "all" | "attached" | "unbound";

const internalSelectedWorkflowName$ = state<string | null>(null);
const internalSelectedWorkflowFilePath$ = state<string | null>(null);
const internalWorkflowSearch$ = state("");
const internalSelectedAgentId$ = state<string | null>(null);
const internalAttachmentFilter$ = state<WorkflowAttachmentFilter>("all");

export const workflowSearch$ = computed((get) => {
  return get(internalWorkflowSearch$);
});

export const selectedWorkflowAgentId$ = computed((get) => {
  return get(internalSelectedAgentId$);
});

export const workflowAttachmentFilter$ = computed((get) => {
  return get(internalAttachmentFilter$);
});

export const selectedWorkflowFilePath$ = computed((get) => {
  return get(internalSelectedWorkflowFilePath$);
});

export const setWorkflowSearch$ = command(({ set }, value: string) => {
  set(internalWorkflowSearch$, value);
});

export const setSelectedWorkflowAgentId$ = command(
  ({ set }, agentId: string | null) => {
    set(internalSelectedAgentId$, agentId);
  },
);

export const setWorkflowAttachmentFilter$ = command(
  ({ set }, filter: WorkflowAttachmentFilter) => {
    set(internalAttachmentFilter$, filter);
  },
);

export const setSelectedWorkflowName$ = command(
  ({ set }, workflowName: string | null) => {
    set(internalSelectedWorkflowName$, workflowName);
    set(internalSelectedWorkflowFilePath$, null);
  },
);

export const setSelectedWorkflowFilePath$ = command(
  ({ set }, filePath: string | null) => {
    set(internalSelectedWorkflowFilePath$, filePath);
  },
);

export const selectedWorkflowName$ = computed((get) => {
  return get(internalSelectedWorkflowName$);
});

export const orgWorkflows$ = computed(
  async (get): Promise<readonly ZeroWorkflowSummary[]> => {
    const client = get(zeroClient$)(zeroWorkflowsCollectionContract);
    const result = await accept(client.list(), [200], { toast: false });
    return result.body;
  },
);

export const workflowAgentOptions$ = computed(
  async (get): Promise<readonly ZeroWorkflowAgentSummary[]> => {
    const workflows = await get(orgWorkflows$);
    const agents = new Map<string, ZeroWorkflowAgentSummary>();

    for (const workflow of workflows) {
      for (const agent of workflow.attachedAgents) {
        agents.set(agent.agentId, agent);
      }
    }

    return [...agents.values()].sort((left, right) => {
      return agentTitle(left).localeCompare(agentTitle(right));
    });
  },
);

export const filteredOrgWorkflows$ = computed(
  async (get): Promise<readonly ZeroWorkflowSummary[]> => {
    const workflows = await get(orgWorkflows$);
    const search = get(internalWorkflowSearch$).trim().toLowerCase();
    const selectedAgentId = get(internalSelectedAgentId$);
    const attachmentFilter = get(internalAttachmentFilter$);

    return workflows.filter((workflow) => {
      if (
        attachmentFilter === "attached" &&
        workflow.attachedAgentCount === 0
      ) {
        return false;
      }

      if (attachmentFilter === "unbound" && workflow.attachedAgentCount !== 0) {
        return false;
      }

      if (
        selectedAgentId &&
        !workflow.attachedAgents.some((agent) => {
          return agent.agentId === selectedAgentId;
        })
      ) {
        return false;
      }

      if (!search) {
        return true;
      }

      const haystack = [
        workflow.name,
        workflow.displayName ?? "",
        workflow.description ?? "",
        workflow.visibility,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(search);
    });
  },
);

export const selectedWorkflowDetail$ = computed(
  async (get): Promise<ZeroWorkflowDetailResponse | null> => {
    const workflowName = await get(selectedWorkflowName$);
    if (!workflowName) {
      return null;
    }

    const client = get(zeroClient$)(zeroWorkflowsDetailContract);
    const result = await accept(
      client.get({ params: { name: workflowName } }),
      [200],
      { toast: false },
    );
    return result.body;
  },
);

function agentTitle(agent: ZeroWorkflowAgentSummary): string {
  return agent.displayName ?? agent.agentId;
}
