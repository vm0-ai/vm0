import { command, computed, state, type Computed } from "ccstate";
import {
  zeroWorkflowsCollectionContract,
  zeroWorkflowsDetailContract,
  zeroWorkflowTriggersContract,
  zeroWorkflowVisibilityContract,
  type ZeroWorkflowCreateRequest,
  type ZeroWorkflowDetailResponse,
  type ZeroWorkflowSchedule,
  type ZeroWorkflowSummary,
  type ZeroWorkflowUpdateRequest,
} from "@vm0/api-contracts/contracts/zero-workflows";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { activeRoute$ } from "../active-route.ts";
import { pathParams$ } from "../route.ts";
import { currentChatAgentRecordId$ } from "../agent-chat.ts";

/**
 * The workflow uuid for the active detail route, or null elsewhere.
 */
export const currentWorkflowId$ = computed((get): string | null => {
  if (get(activeRoute$) !== "agentWorkflowDetail") {
    return null;
  }
  const workflowId = get(pathParams$)?.workflowId;
  return typeof workflowId === "string" ? workflowId : null;
});

const internalWorkflowReload$ = state(0);

const internalSelectedFilePath$ = state<string | null>(null);
const internalWorkflowSearch$ = state("");

export const workflowSearch$ = computed((get) => {
  return get(internalWorkflowSearch$);
});

export const setWorkflowSearch$ = command(({ set }, value: string) => {
  set(internalWorkflowSearch$, value);
});

function matchesWorkflowSearch(
  workflow: ZeroWorkflowSummary,
  search: string,
): boolean {
  if (!search) {
    return true;
  }
  return [
    workflow.name,
    workflow.displayName ?? "",
    workflow.description ?? "",
    workflow.agentDisplayName ?? "",
    workflow.agentName ?? "",
  ]
    .join(" ")
    .toLowerCase()
    .includes(search);
}

export const filteredVisibleWorkflows$ = computed(
  async (get): Promise<readonly ZeroWorkflowSummary[]> => {
    const workflows = await get(allVisibleWorkflows$);
    const search = get(internalWorkflowSearch$).trim().toLowerCase();
    return workflows.filter((workflow) => {
      return matchesWorkflowSearch(workflow, search);
    });
  },
);

/** The supplementary file selected in the detail viewer, or null. */
export const selectedWorkflowFilePath$ = computed((get) => {
  return get(internalSelectedFilePath$);
});

export const setSelectedWorkflowFilePath$ = command(
  ({ set }, path: string | null) => {
    set(internalSelectedFilePath$, path);
  },
);

/** Bump to refetch every workflow list and detail. */
const reloadWorkflows$ = command(({ set }) => {
  set(internalWorkflowReload$, (prev) => {
    return prev + 1;
  });
});

/**
 * The user's visible workflows across every agent. Used by the read-only
 * cross-agent index at `/workflows`.
 */
const allVisibleWorkflows$ = computed(
  async (get): Promise<readonly ZeroWorkflowSummary[]> => {
    get(internalWorkflowReload$);
    const client = get(zeroClient$)(zeroWorkflowsCollectionContract);
    const result = await accept(client.list(), [200], { toast: false });
    return result.body;
  },
);

/**
 * Factory for a single agent's visible workflows (public ∪ the caller's own
 * private), scoped via the `agentId` query parameter.
 */
function createAgentWorkflowsFactory(): (
  agentId: string,
) => Computed<Promise<readonly ZeroWorkflowSummary[]>> {
  const cache = new Map<
    string,
    Computed<Promise<readonly ZeroWorkflowSummary[]>>
  >();
  return (agentId: string) => {
    const existing = cache.get(agentId);
    if (existing) {
      return existing;
    }
    const atom$ = computed(async (get) => {
      get(internalWorkflowReload$);
      const client = get(zeroClient$)(zeroWorkflowsCollectionContract);
      const result = await accept(client.list({ query: { agentId } }), [200], {
        toast: false,
      });
      return result.body;
    });
    cache.set(agentId, atom$);
    return atom$;
  };
}

export const agentWorkflows = createAgentWorkflowsFactory();

/**
 * The current chat agent's visible workflows, used by the slash-workflow
 * composer. Empty until an agent is resolved.
 */
export const composerWorkflows$ = computed(
  async (get): Promise<readonly ZeroWorkflowSummary[]> => {
    const agentId = await get(currentChatAgentRecordId$);
    if (!agentId) {
      return [];
    }
    return get(agentWorkflows(agentId));
  },
);

/**
 * Factory for a single workflow's detail, addressed by its uuid.
 */
function createWorkflowDetailFactory(): (
  workflowId: string,
) => Computed<Promise<ZeroWorkflowDetailResponse | null>> {
  const cache = new Map<
    string,
    Computed<Promise<ZeroWorkflowDetailResponse | null>>
  >();
  return (workflowId: string) => {
    const existing = cache.get(workflowId);
    if (existing) {
      return existing;
    }
    const atom$ = computed(async (get) => {
      get(internalWorkflowReload$);
      const client = get(zeroClient$)(zeroWorkflowsDetailContract);
      const result = await accept(
        client.get({ params: { workflowId } }),
        [200, 404],
        { toast: false },
      );
      if (result.status === 404) {
        return null;
      }
      return result.body;
    });
    cache.set(workflowId, atom$);
    return atom$;
  };
}

export const workflowDetail = createWorkflowDetailFactory();

export const createWorkflow$ = command(
  async (
    { get, set },
    input: ZeroWorkflowCreateRequest,
    signal: AbortSignal,
  ): Promise<ZeroWorkflowSummary> => {
    const client = get(zeroClient$)(zeroWorkflowsCollectionContract);
    const result = await accept(
      client.create({ body: input, fetchOptions: { signal } }),
      [201],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
    return result.body;
  },
);

export const updateWorkflow$ = command(
  async (
    { get, set },
    input: { workflowId: string; body: ZeroWorkflowUpdateRequest },
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroWorkflowsDetailContract);
    await accept(
      client.update({
        params: { workflowId: input.workflowId },
        body: input.body,
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
  },
);

export const deleteWorkflow$ = command(
  async ({ get, set }, workflowId: string, signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroWorkflowsDetailContract);
    await accept(
      client.delete({
        params: { workflowId },
        fetchOptions: { signal },
      }),
      [204],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
  },
);

export const copyWorkflow$ = command(
  async (
    { get, set },
    input: { workflowId: string; toAgentId: string },
    signal: AbortSignal,
  ): Promise<ZeroWorkflowSummary> => {
    const client = get(zeroClient$)(zeroWorkflowsDetailContract);
    const result = await accept(
      client.copy({
        params: { workflowId: input.workflowId },
        body: { toAgentId: input.toAgentId },
        fetchOptions: { signal },
      }),
      [201],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
    return result.body;
  },
);

export const runWorkflow$ = command(
  async (
    { get },
    workflowId: string,
    signal: AbortSignal,
  ): Promise<{ chatThreadId: string; runId: string }> => {
    const client = get(zeroClient$)(zeroWorkflowsDetailContract);
    const result = await accept(
      client.run({
        params: { workflowId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    return result.body;
  },
);

type WorkflowVisibilityAction =
  | "request-publish"
  | "cancel-publish-request"
  | "approve-publish"
  | "reject-publish"
  | "demote";

export const changeWorkflowVisibility$ = command(
  async (
    { get, set },
    input: { workflowId: string; action: WorkflowVisibilityAction },
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroWorkflowVisibilityContract);
    const params = { workflowId: input.workflowId };
    const options = { params, fetchOptions: { signal } };
    const request =
      input.action === "request-publish"
        ? client.requestPublish(options)
        : input.action === "cancel-publish-request"
          ? client.cancelPublishRequest(options)
          : input.action === "approve-publish"
            ? client.approvePublish(options)
            : input.action === "reject-publish"
              ? client.rejectPublish(options)
              : client.demote(options);
    await accept(request, [200]);
    signal.throwIfAborted();
    set(reloadWorkflows$);
  },
);

export const createWorkflowScheduleTrigger$ = command(
  async (
    { get, set },
    input: { workflowId: string; schedule: ZeroWorkflowSchedule },
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroWorkflowTriggersContract);
    await accept(
      client.create({
        params: { workflowId: input.workflowId },
        body: { schedule: input.schedule },
        fetchOptions: { signal },
      }),
      [201],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
  },
);

export const setWorkflowTriggerEnabled$ = command(
  async (
    { get, set },
    input: { triggerId: string; enabled: boolean },
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroWorkflowTriggersContract);
    const request = input.enabled
      ? client.enable({
          params: { id: input.triggerId },
          fetchOptions: { signal },
        })
      : client.disable({
          params: { id: input.triggerId },
          fetchOptions: { signal },
        });
    await accept(request, [200]);
    signal.throwIfAborted();
    set(reloadWorkflows$);
  },
);

export const deleteWorkflowScheduleTrigger$ = command(
  async ({ get, set }, triggerId: string, signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroWorkflowTriggersContract);
    await accept(
      client.delete({ params: { id: triggerId }, fetchOptions: { signal } }),
      [204],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
  },
);

export const runWorkflowScheduleTrigger$ = command(
  async ({ get }, triggerId: string, signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroWorkflowTriggersContract);
    await accept(
      client.run({ params: { id: triggerId }, fetchOptions: { signal } }),
      [200],
    );
    signal.throwIfAborted();
  },
);
