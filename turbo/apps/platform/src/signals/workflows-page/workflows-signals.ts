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
  type ZeroWorkflowScheduleType,
  type ZeroWorkflowSummary,
  type ZeroWorkflowTriggerSummary,
  type ZeroWorkflowUpdateRequest,
  type UnattendedTriggerConnectorRefs,
  type UnattendedTriggerPermissionPolicy,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { zeroWorkflowUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { activeRoute$ } from "../active-route.ts";
import {
  pathParams$,
  replaceSearchParams$,
  searchParams$,
  updateSearchParams$,
} from "../route.ts";
import { currentChatAgentRecordId$ } from "../agent-chat.ts";

type WorkflowDetailActionDialog = "edit" | "copy" | "delete" | null;
export type WorkflowDetailTab = "authorization" | "triggers" | "info";
type WorkflowTriggerCreateDialog =
  | "schedule"
  | "gmail"
  | "gmail-label"
  | "webhook"
  | null;
type WorkflowWebhookTriggerSummary = Extract<
  ZeroWorkflowTriggerSummary,
  { readonly kind: "event"; readonly eventType: "webhook-received" }
>;
const WORKFLOW_DETAIL_SIDEBAR_PARAM = "sidebar";
const WORKFLOW_TRIGGER_SIDEBAR_VALUE = "triggers";
export const WORKFLOW_DETAIL_TAB_PARAM = "tab";
const WORKFLOW_DETAIL_TABS = new Set<WorkflowDetailTab>([
  "authorization",
  "triggers",
  "info",
]);

function workflowDetailTabFromSearchParams(
  params: URLSearchParams,
): WorkflowDetailTab | null {
  const value = params.get(WORKFLOW_DETAIL_TAB_PARAM);
  return WORKFLOW_DETAIL_TABS.has(value as WorkflowDetailTab)
    ? (value as WorkflowDetailTab)
    : null;
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

interface WorkflowEditDraft {
  readonly workflowId: string;
  readonly displayName: string;
  readonly name: string;
  readonly description: string;
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
const internalWorkflowEditDraft$ = state<WorkflowEditDraft | null>(null);
const internalWorkflowTriggerPermissionsDrawerTriggerId$ = state<string | null>(
  null,
);
const internalWorkflowTriggerCreateDialog$ =
  state<WorkflowTriggerCreateDialog>(null);
const internalScheduleTriggerType$ = state<ZeroWorkflowScheduleType>("cron");
const internalCreatedWorkflowWebhookTrigger$ =
  state<WorkflowWebhookTriggerSummary | null>(null);
const internalCreateScheduleCronFields$ = state<WorkflowCronFields>(
  defaultWorkflowCronFields(),
);
const internalEditingScheduleCronFields$ = state<WorkflowCronFields>(
  defaultWorkflowCronFields(),
);

export const workflowDetailTriggerSidebarOpen$ = computed((get) => {
  return (
    get(searchParams$).get(WORKFLOW_DETAIL_SIDEBAR_PARAM) ===
    WORKFLOW_TRIGGER_SIDEBAR_VALUE
  );
});

export const setWorkflowDetailTriggerSidebarOpen$ = command(
  ({ get, set }, open: boolean) => {
    const params = new URLSearchParams(get(searchParams$));
    const currentlyOpen =
      params.get(WORKFLOW_DETAIL_SIDEBAR_PARAM) ===
      WORKFLOW_TRIGGER_SIDEBAR_VALUE;
    if (open === currentlyOpen) {
      return;
    }
    if (open) {
      params.set(WORKFLOW_DETAIL_SIDEBAR_PARAM, WORKFLOW_TRIGGER_SIDEBAR_VALUE);
      set(updateSearchParams$, params);
      return;
    }

    const createdWebhookTrigger = get(internalCreatedWorkflowWebhookTrigger$);
    if (createdWebhookTrigger) {
      set(reloadWorkflows$);
    }
    params.delete(WORKFLOW_DETAIL_SIDEBAR_PARAM);
    set(internalEditingWorkflowTriggerId$, null);
    set(internalWorkflowTriggerPermissionsDrawerTriggerId$, null);
    set(internalWorkflowTriggerCreateDialog$, null);
    set(internalCreatedWorkflowWebhookTrigger$, null);
    set(replaceSearchParams$, params);
  },
);

export const workflowActionDialog$ = computed((get) => {
  return get(internalWorkflowActionDialog$);
});

export const setWorkflowActionDialog$ = command(
  ({ set }, dialog: WorkflowDetailActionDialog) => {
    set(internalWorkflowActionDialog$, dialog);
    if (dialog !== "edit") {
      set(internalWorkflowEditDraft$, null);
    }
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

export const workflowEditDraft$ = computed((get) => {
  return get(internalWorkflowEditDraft$);
});

export const openWorkflowEditDialog$ = command(
  ({ set }, detail: ZeroWorkflowDetailResponse) => {
    set(internalWorkflowEditDraft$, {
      workflowId: detail.id,
      displayName: detail.displayName ?? "",
      name: detail.name,
      description: detail.description ?? "",
    });
    set(internalWorkflowActionDialog$, "edit");
  },
);

export const patchWorkflowEditDraft$ = command(
  (
    { set },
    input: {
      readonly workflowId: string;
      readonly patch: Partial<Omit<WorkflowEditDraft, "workflowId">>;
    },
  ) => {
    set(internalWorkflowEditDraft$, (draft) => {
      if (!draft || draft.workflowId !== input.workflowId) {
        return draft;
      }
      return { ...draft, ...input.patch };
    });
  },
);

export const resetWorkflowDetailUiState$ = command(({ set }) => {
  set(internalWorkflowDetailActiveTab$, "authorization");
  set(internalSelectedFilePath$, null);
  set(internalWorkflowActionDialog$, null);
  set(internalWorkflowFileDraft$, null);
  set(internalEditingWorkflowTriggerId$, null);
  set(internalWorkflowEditDraft$, null);
  set(internalWorkflowTriggerPermissionsDrawerTriggerId$, null);
  set(internalWorkflowTriggerCreateDialog$, null);
  set(internalCreatedWorkflowWebhookTrigger$, null);
  set(internalScheduleTriggerType$, "cron");
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

export const workflowTriggerPermissionsDrawerTriggerId$ = computed((get) => {
  return get(internalWorkflowTriggerPermissionsDrawerTriggerId$);
});

export const setEditingWorkflowTriggerId$ = command(
  ({ set }, triggerId: string | null) => {
    set(internalEditingWorkflowTriggerId$, triggerId);
  },
);

export const setWorkflowTriggerPermissionsDrawerTriggerId$ = command(
  ({ set }, triggerId: string | null) => {
    set(internalWorkflowTriggerPermissionsDrawerTriggerId$, triggerId);
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
    if (dialog === "schedule") {
      set(internalScheduleTriggerType$, "cron");
      set(internalCreateScheduleCronFields$, defaultWorkflowCronFields());
    }
  },
);

export const scheduleTriggerType$ = computed((get) => {
  return get(internalScheduleTriggerType$);
});

export const setScheduleTriggerType$ = command(
  ({ set }, scheduleType: ZeroWorkflowScheduleType) => {
    set(internalScheduleTriggerType$, scheduleType);
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
  return get(internalSelectedFilePath$);
});

export const setSelectedWorkflowFilePath$ = command(
  ({ set }, path: string | null) => {
    set(internalSelectedFilePath$, path);
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

export const setWorkflowTriggerPermissionPolicy$ = command(
  async (
    { get, set },
    input: {
      triggerId: string;
      unattendedConnectorRefs?: UnattendedTriggerConnectorRefs;
      unattendedPermissionPolicy: UnattendedTriggerPermissionPolicy | null;
    },
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroWorkflowTriggersContract);
    await accept(
      client.setPermissionPolicy({
        params: { id: input.triggerId },
        body: {
          ...(input.unattendedConnectorRefs !== undefined
            ? { unattendedConnectorRefs: input.unattendedConnectorRefs }
            : {}),
          unattendedPermissionPolicy: input.unattendedPermissionPolicy,
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
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
