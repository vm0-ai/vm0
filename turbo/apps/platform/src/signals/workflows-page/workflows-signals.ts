import { command, computed, state, type Computed } from "ccstate";
import {
  zeroWorkflowsCollectionContract,
  zeroWorkflowsDetailContract,
  zeroWorkflowTriggersContract,
  zeroWorkflowVisibilityContract,
  type GmailLabelAppliedEventConfig,
  type GmailNewMessageEventConfig,
  type ZeroWorkflowDetailResponse,
  type ZeroWorkflowSchedule,
  type ZeroWorkflowSummary,
  type ZeroWorkflowTriggerSummary,
  type ZeroWorkflowUpdateRequest,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { zeroWorkflowUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { activeRoute$ } from "../active-route.ts";
import {
  detachedNavigateTo$,
  pathParams$,
  replaceSearchParams$,
  searchParams$,
} from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { currentChatAgentRecordId$ } from "../agent-chat.ts";
import { ensureDraft$ } from "../chat-page/create-chat-thread.ts";

type WorkflowDetailActionDialog = "copy" | "delete" | null;
export type WorkflowDetailTab =
  | "authorization"
  | "triggers"
  | "instructions"
  | "info";
type WorkflowTriggerCreateDialog =
  | "interval"
  | "scheduled"
  | "gmail"
  | "gmail-label"
  | "webhook"
  | null;
type WorkflowWebhookTriggerSummary = Extract<
  ZeroWorkflowTriggerSummary,
  { readonly kind: "event"; readonly eventType: "webhook-received" }
>;
export const WORKFLOW_DETAIL_TAB_PARAM = "tab";
export const WORKFLOW_DETAIL_FILE_PARAM = "file";

function workflowDetailTabFromSearchParams(
  params: URLSearchParams,
): WorkflowDetailTab | null {
  const value = params.get(WORKFLOW_DETAIL_TAB_PARAM);
  switch (value) {
    case "authorization":
    case "triggers":
    case "instructions":
    case "info": {
      return value;
    }
    default: {
      return null;
    }
  }
}

export type WorkflowCronFrequency =
  | "every_day"
  | "every_weekday"
  | "every_week"
  | "every_month"
  | "custom";

export interface WorkflowCronFields {
  readonly frequency: WorkflowCronFrequency;
  readonly hour: number;
  readonly minute: number;
  readonly dayOfWeek: string;
  readonly dayOfMonth: string;
  readonly customCronExpression: string;
}

export function defaultWorkflowCronFields(): WorkflowCronFields {
  return {
    frequency: "every_day",
    hour: 9,
    minute: 0,
    dayOfWeek: "1",
    dayOfMonth: "1",
    customCronExpression: "0 9 * * *",
  };
}

interface WorkflowDetailFileDraft {
  readonly workflowId: string;
  readonly filePath: string | null;
  readonly sourceContent: string;
  readonly content: string;
}

interface WorkflowMetadataPatch {
  readonly workflowId: string;
  readonly displayName?: string;
  readonly name?: string;
  readonly description?: string;
}

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
const internalWorkflowConnectorAuthorizationsReload$ = state(0);
const internalWorkflowDetailActiveTab$ =
  state<WorkflowDetailTab>("authorization");

const internalSelectedFilePath$ = state<string | null>(null);
const internalWorkflowActionDialog$ = state<WorkflowDetailActionDialog>(null);
const internalWorkflowFileDraft$ = state<WorkflowDetailFileDraft | null>(null);
const internalEditingWorkflowTriggerId$ = state<string | null>(null);
const internalWorkflowMetadataPatch$ = state<WorkflowMetadataPatch | null>(
  null,
);
const internalWorkflowTriggerCreateDialog$ =
  state<WorkflowTriggerCreateDialog>(null);
const internalCreatedWorkflowWebhookTrigger$ =
  state<WorkflowWebhookTriggerSummary | null>(null);
const internalCreateScheduleCronFields$ = state<WorkflowCronFields>(
  defaultWorkflowCronFields(),
);
const internalEditingScheduleCronFields$ = state<WorkflowCronFields>(
  defaultWorkflowCronFields(),
);

export const workflowActionDialog$ = computed((get) => {
  return get(internalWorkflowActionDialog$);
});

export const setWorkflowActionDialog$ = command(
  ({ set }, dialog: WorkflowDetailActionDialog) => {
    set(internalWorkflowActionDialog$, dialog);
  },
);

export const workflowFileDraft$ = computed((get) => {
  return get(internalWorkflowFileDraft$);
});

export const setWorkflowFileDraft$ = command(
  ({ set }, draft: WorkflowDetailFileDraft | null) => {
    set(internalWorkflowFileDraft$, draft);
  },
);

export const workflowMetadataPatch$ = computed((get) => {
  return get(internalWorkflowMetadataPatch$);
});

export const patchWorkflowMetadataForm$ = command(
  (
    { set },
    input: {
      readonly workflowId: string;
      readonly patch: Omit<WorkflowMetadataPatch, "workflowId">;
    },
  ) => {
    set(internalWorkflowMetadataPatch$, (patch) => {
      if (!patch || patch.workflowId !== input.workflowId) {
        return { workflowId: input.workflowId, ...input.patch };
      }
      return { ...patch, ...input.patch };
    });
  },
);

export const resetWorkflowMetadataForm$ = command(({ set }) => {
  set(internalWorkflowMetadataPatch$, null);
});

export const resetWorkflowDetailUiState$ = command(({ set }) => {
  set(internalWorkflowDetailActiveTab$, "authorization");
  set(internalSelectedFilePath$, null);
  set(internalWorkflowActionDialog$, null);
  set(internalWorkflowFileDraft$, null);
  set(internalEditingWorkflowTriggerId$, null);
  set(internalWorkflowMetadataPatch$, null);
  set(internalWorkflowTriggerCreateDialog$, null);
  set(internalCreatedWorkflowWebhookTrigger$, null);
  set(internalCreateScheduleCronFields$, defaultWorkflowCronFields());
  set(internalEditingScheduleCronFields$, defaultWorkflowCronFields());
});

export const workflowDetailActiveTab$ = computed((get) => {
  return (
    workflowDetailTabFromSearchParams(get(searchParams$)) ??
    get(internalWorkflowDetailActiveTab$)
  );
});

export const setWorkflowDetailActiveTab$ = command(
  ({ get, set }, tab: WorkflowDetailTab) => {
    set(internalWorkflowDetailActiveTab$, tab);
    const params = new URLSearchParams(get(searchParams$));
    params.set(WORKFLOW_DETAIL_TAB_PARAM, tab);
    set(replaceSearchParams$, params);
  },
);

export const reloadWorkflowConnectorAuthorizations$ = command(({ set }) => {
  set(internalWorkflowConnectorAuthorizationsReload$, (prev) => {
    return prev + 1;
  });
});

export const editingWorkflowTriggerId$ = computed((get) => {
  return get(internalEditingWorkflowTriggerId$);
});

export const setEditingWorkflowTriggerId$ = command(
  ({ set }, triggerId: string | null) => {
    set(internalEditingWorkflowTriggerId$, triggerId);
  },
);

export const workflowTriggerCreateDialog$ = computed((get) => {
  return get(internalWorkflowTriggerCreateDialog$);
});

export const createdWorkflowWebhookTrigger$ = computed((get) => {
  return get(internalCreatedWorkflowWebhookTrigger$);
});

export const setCreatedWorkflowWebhookTrigger$ = command(
  ({ set }, trigger: WorkflowWebhookTriggerSummary | null) => {
    set(internalCreatedWorkflowWebhookTrigger$, trigger);
  },
);

export const setWorkflowTriggerCreateDialog$ = command(
  ({ set }, dialog: WorkflowTriggerCreateDialog) => {
    set(internalWorkflowTriggerCreateDialog$, dialog);
    if (dialog !== "webhook") {
      set(internalCreatedWorkflowWebhookTrigger$, null);
    }
    if (dialog === "scheduled") {
      set(internalCreateScheduleCronFields$, defaultWorkflowCronFields());
    }
  },
);

export const createScheduleCronFields$ = computed((get) => {
  return get(internalCreateScheduleCronFields$);
});

export const setCreateScheduleCronFields$ = command(
  ({ set }, fields: WorkflowCronFields) => {
    set(internalCreateScheduleCronFields$, fields);
  },
);

export const editingScheduleCronFields$ = computed((get) => {
  return get(internalEditingScheduleCronFields$);
});

export const setEditingScheduleCronFields$ = command(
  ({ set }, fields: WorkflowCronFields) => {
    set(internalEditingScheduleCronFields$, fields);
  },
);

/** The supplementary file selected in the detail viewer, or null. */
export const selectedWorkflowFilePath$ = computed((get) => {
  return (
    get(searchParams$).get(WORKFLOW_DETAIL_FILE_PARAM) ??
    get(internalSelectedFilePath$)
  );
});

export const setSelectedWorkflowFilePath$ = command(
  ({ get, set }, path: string | null) => {
    set(internalSelectedFilePath$, path);
    const params = new URLSearchParams(get(searchParams$));
    if (path) {
      params.set(WORKFLOW_DETAIL_FILE_PARAM, path);
    } else {
      params.delete(WORKFLOW_DETAIL_FILE_PARAM);
    }
    params.set(WORKFLOW_DETAIL_TAB_PARAM, "instructions");
    set(replaceSearchParams$, params);
  },
);

/** Bump to refetch every workflow list and detail. */
export const reloadWorkflows$ = command(({ set }) => {
  set(internalWorkflowReload$, (prev) => {
    return prev + 1;
  });
});

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
      const result = await accept(client.list({ query: { agentId } }), [200]);
      return result.body;
    });
    cache.set(agentId, atom$);
    return atom$;
  };
}

const agentWorkflows = createAgentWorkflowsFactory();
export const agentVisibleWorkflows$ = agentWorkflows;

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

function createWorkflowAuthorizedConnectorsFactory(): (
  workflowId: string,
) => Computed<Promise<readonly string[]>> {
  const cache = new Map<string, Computed<Promise<readonly string[]>>>();
  return (workflowId: string) => {
    const existing = cache.get(workflowId);
    if (existing) {
      return existing;
    }
    const atom$ = computed(async (get) => {
      get(internalWorkflowConnectorAuthorizationsReload$);
      const client = get(zeroClient$)(zeroWorkflowUserConnectorsContract);
      const result = await accept(
        client.get({ params: { id: workflowId } }),
        [200],
      );
      return result.body.enabledTypes;
    });
    cache.set(workflowId, atom$);
    return atom$;
  };
}

export const workflowAuthorizedConnectors =
  createWorkflowAuthorizedConnectorsFactory();

export const setWorkflowAuthorizedConnectors$ = command(
  async (
    { get, set },
    input: { readonly workflowId: string; readonly enabledTypes: string[] },
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroWorkflowUserConnectorsContract);
    await accept(
      client.update({
        params: { id: input.workflowId },
        body: { enabledTypes: input.enabledTypes },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadWorkflowConnectorAuthorizations$);
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

export const openWorkflowChat$ = command(
  async ({ get, set }, workflowId: string, signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroWorkflowsDetailContract);
    const result = await accept(
      client.chatThread({
        params: { workflowId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    const { draft } = set(ensureDraft$, result.body.chatThreadId);
    set(draft.clear$);
    set(draft.setInput$, result.body.prompt);
    set(detachedNavigateTo$, ROUTES.chat, {
      pathParams: { threadId: result.body.chatThreadId },
    });
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

export const createWorkflowGmailNewMessageTrigger$ = command(
  async (
    { get, set },
    input: {
      readonly workflowId: string;
      readonly eventConfig: GmailNewMessageEventConfig;
    },
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroWorkflowTriggersContract);
    await accept(
      client.create({
        params: { workflowId: input.workflowId },
        body: {
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: input.eventConfig,
        },
        fetchOptions: { signal },
      }),
      [201],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
  },
);

export const createWorkflowGmailLabelAppliedTrigger$ = command(
  async (
    { get, set },
    input: {
      readonly workflowId: string;
      readonly eventConfig: GmailLabelAppliedEventConfig;
    },
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroWorkflowTriggersContract);
    await accept(
      client.create({
        params: { workflowId: input.workflowId },
        body: {
          kind: "event",
          eventType: "gmail-label-applied",
          eventConfig: input.eventConfig,
        },
        fetchOptions: { signal },
      }),
      [201],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
  },
);

export const createWorkflowWebhookTrigger$ = command(
  async (
    { get },
    input: { readonly workflowId: string },
    signal: AbortSignal,
  ): Promise<WorkflowWebhookTriggerSummary> => {
    const client = get(zeroClient$)(zeroWorkflowTriggersContract);
    const result = await accept(
      client.create({
        params: { workflowId: input.workflowId },
        body: {
          kind: "event",
          eventType: "webhook-received",
          eventConfig: {
            provider: "webhook",
            event: "received",
            auth: { mode: "hmac-sha256" },
          },
        },
        fetchOptions: { signal },
      }),
      [201],
    );
    signal.throwIfAborted();
    if (
      result.body.kind !== "event" ||
      result.body.eventType !== "webhook-received"
    ) {
      throw new Error("Expected webhook workflow trigger summary");
    }
    return result.body;
  },
);

export const updateWorkflowGmailNewMessageTrigger$ = command(
  async (
    { get, set },
    input: {
      readonly triggerId: string;
      readonly eventConfig: GmailNewMessageEventConfig;
    },
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroWorkflowTriggersContract);
    await accept(
      client.update({
        params: { id: input.triggerId },
        body: { eventConfig: input.eventConfig },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
  },
);

export const updateWorkflowGmailLabelAppliedTrigger$ = command(
  async (
    { get, set },
    input: {
      readonly triggerId: string;
      readonly eventConfig: GmailLabelAppliedEventConfig;
    },
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroWorkflowTriggersContract);
    await accept(
      client.update({
        params: { id: input.triggerId },
        body: { eventConfig: input.eventConfig },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
  },
);

export const updateWorkflowScheduleTrigger$ = command(
  async (
    { get, set },
    input: {
      readonly triggerId: string;
      readonly schedule: ZeroWorkflowSchedule;
    },
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroWorkflowTriggersContract);
    await accept(
      client.update({
        params: { id: input.triggerId },
        body: { schedule: input.schedule },
        fetchOptions: { signal },
      }),
      [200],
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

export const runWorkflowTriggerNow$ = command(
  async ({ get, set }, triggerId: string, signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroWorkflowTriggersContract);
    const result = await accept(
      client.run({
        params: { id: triggerId },
        fetchOptions: { signal },
      }),
      [201],
    );
    signal.throwIfAborted();
    set(detachedNavigateTo$, ROUTES.chat, {
      pathParams: { threadId: result.body.chatThreadId },
    });
  },
);

export const deleteWorkflowTrigger$ = command(
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
