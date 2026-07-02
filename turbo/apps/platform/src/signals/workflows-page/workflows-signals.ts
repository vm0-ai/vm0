import { command, computed, state, type Computed } from "ccstate";
import {
  zeroWorkflowsCollectionContract,
  zeroWorkflowsDetailContract,
  zeroWorkflowTriggersContract,
  zeroWorkflowVisibilityContract,
  type GmailLabelAppliedEventConfig,
  type GmailNewMessageEventConfig,
  type GoogleCalendarEventCancelledEventConfig,
  type GoogleCalendarEventCreatedEventConfig,
  type GoogleCalendarEventUpdatedEventConfig,
  type GithubLabelAppliedEventConfig,
  type ZeroWorkflowDetailResponse,
  type ZeroWorkflowSchedule,
  type ZeroWorkflowSummary,
  type ZeroWorkflowTriggerAutomationEntry,
  type ZeroWorkflowTriggerCreateRequest,
  type ZeroWorkflowTriggerSummary,
  type ZeroWorkflowUpdateRequest,
} from "@vm0/api-contracts/contracts/zero-workflows";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { activeRoute$ } from "../active-route.ts";
import {
  detachedNavigateTo$,
  pathParams$,
  replacePathSilently$,
  replaceSearchParams$,
  searchParams$,
} from "../route.ts";
import {
  isWorkflowDetailRouteKey,
  ROUTES,
  type RouteKey,
} from "../route-paths.ts";
import { currentChatAgentRecordId$ } from "../agent-chat.ts";
import { ensureDraft$ } from "../chat-page/create-chat-thread.ts";

type WorkflowDetailActionDialog = "copy" | "delete" | null;
export type WorkflowDetailTab = "automations" | "instructions" | "info";
export type WorkflowAutomationFilter = "all" | "automated" | "without";
export type WorkflowVisibilityFilter = "all" | "private" | "public";
export type WorkflowSortMode = "recent" | "next-run";
export type WorkflowCopyDialogAgent = {
  readonly id: string;
  readonly displayName: string | null;
  readonly visibility?: string | null;
};
export type WorkflowCopyDialogState =
  | { readonly kind: "select" }
  | { readonly kind: "copying"; readonly agent: WorkflowCopyDialogAgent }
  | {
      readonly kind: "copied";
      readonly agent: WorkflowCopyDialogAgent;
      readonly workflow: ZeroWorkflowSummary;
      readonly sourceTriggersPaused: boolean;
    };
type WorkflowTriggerCreateDialog =
  | "interval"
  | "scheduled"
  | "once"
  | "gmail"
  | "gmail-label"
  | "github-label"
  | "google-calendar-created"
  | "google-calendar-updated"
  | "google-calendar-cancelled"
  | "webhook"
  | null;
type WorkflowWebhookTriggerSummary = Extract<
  ZeroWorkflowTriggerSummary,
  { readonly kind: "event"; readonly eventType: "webhook-received" }
>;
type WorkflowGithubLabelActor =
  GithubLabelAppliedEventConfig["filters"]["actor"]["type"];
export type WorkflowTriggerAutomationEntry = ZeroWorkflowTriggerAutomationEntry;
export const WORKFLOW_DETAIL_FILE_PARAM = "file";

function workflowDetailTabFromRoute(route: RouteKey | null): WorkflowDetailTab {
  switch (route) {
    case "workflowDetail":
    case "workflowDetailAutomations": {
      return "automations";
    }
    case "workflowDetailInstructions": {
      return "instructions";
    }
    case "workflowDetailInfo": {
      return "info";
    }
    default: {
      return "automations";
    }
  }
}

export function workflowDetailRouteForTab(
  tab: WorkflowDetailTab,
):
  | typeof ROUTES.workflowDetailAutomations
  | typeof ROUTES.workflowDetailInstructions
  | typeof ROUTES.workflowDetailInfo {
  switch (tab) {
    case "automations": {
      return ROUTES.workflowDetailAutomations;
    }
    case "instructions": {
      return ROUTES.workflowDetailInstructions;
    }
    case "info": {
      return ROUTES.workflowDetailInfo;
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
  const route = get(activeRoute$);
  if (!isWorkflowDetailRouteKey(route)) {
    return null;
  }
  const workflowId = get(pathParams$)?.workflowId;
  return typeof workflowId === "string" ? workflowId : null;
});

const internalWorkflowReload$ = state(0);
const internalWorkflowDetailActiveTab$ =
  state<WorkflowDetailTab>("automations");

const internalSelectedFilePath$ = state<string | null>(null);
const internalWorkflowActionDialog$ = state<WorkflowDetailActionDialog>(null);
const internalWorkflowCopyDialogState$ = state<WorkflowCopyDialogState>({
  kind: "select",
});
const internalWorkflowFileDraft$ = state<WorkflowDetailFileDraft | null>(null);
const internalEditingWorkflowTriggerId$ = state<string | null>(null);
const internalWorkflowMetadataPatch$ = state<WorkflowMetadataPatch | null>(
  null,
);
const internalWorkflowTriggerCreateDialog$ =
  state<WorkflowTriggerCreateDialog>(null);
const internalCreatedWorkflowWebhookTrigger$ =
  state<WorkflowWebhookTriggerSummary | null>(null);
const internalCreateGithubLabelActor$ = state<WorkflowGithubLabelActor>("me");
const internalEditingGithubLabelActors$ = state<
  Record<string, WorkflowGithubLabelActor>
>({});
const internalCreateScheduleCronFields$ = state<WorkflowCronFields>(
  defaultWorkflowCronFields(),
);
const internalEditingScheduleCronFields$ = state<WorkflowCronFields>(
  defaultWorkflowCronFields(),
);

export const workflowActionDialog$ = computed((get) => {
  return get(internalWorkflowActionDialog$);
});

export const workflowCopyDialogState$ = computed((get) => {
  return get(internalWorkflowCopyDialogState$);
});

const AUTOMATION_FILTER_PARAM = "automation";
const VISIBILITY_FILTER_PARAM = "visibility";
const SORT_MODE_PARAM = "sort";

function readSearchParam<T extends string>(
  params: URLSearchParams,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = params.get(key) ?? "";
  return (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

export const workflowAutomationFilter$ = computed(
  (get): WorkflowAutomationFilter => {
    return readSearchParam(
      get(searchParams$),
      AUTOMATION_FILTER_PARAM,
      ["all", "automated", "without"],
      "all",
    );
  },
);

export const workflowVisibilityFilter$ = computed(
  (get): WorkflowVisibilityFilter => {
    return readSearchParam(
      get(searchParams$),
      VISIBILITY_FILTER_PARAM,
      ["all", "private", "public"],
      "all",
    );
  },
);

export const workflowSortMode$ = computed((get): WorkflowSortMode => {
  return readSearchParam(
    get(searchParams$),
    SORT_MODE_PARAM,
    ["recent", "next-run"],
    "recent",
  );
});

function nextSearchParams(
  current: URLSearchParams,
  key: string,
  value: string,
  fallback: string,
): URLSearchParams {
  const params = new URLSearchParams(current);
  if (value === fallback) {
    params.delete(key);
  } else {
    params.set(key, value);
  }
  return params;
}

export const setWorkflowAutomationFilter$ = command(
  ({ get, set }, value: WorkflowAutomationFilter) => {
    set(
      replaceSearchParams$,
      nextSearchParams(
        get(searchParams$),
        AUTOMATION_FILTER_PARAM,
        value,
        "all",
      ),
    );
  },
);

export const setWorkflowVisibilityFilter$ = command(
  ({ get, set }, value: WorkflowVisibilityFilter) => {
    set(
      replaceSearchParams$,
      nextSearchParams(
        get(searchParams$),
        VISIBILITY_FILTER_PARAM,
        value,
        "all",
      ),
    );
  },
);

export const setWorkflowSortMode$ = command(
  ({ get, set }, value: WorkflowSortMode) => {
    set(
      replaceSearchParams$,
      nextSearchParams(get(searchParams$), SORT_MODE_PARAM, value, "recent"),
    );
  },
);

export const setWorkflowActionDialog$ = command(
  ({ set }, dialog: WorkflowDetailActionDialog) => {
    set(internalWorkflowActionDialog$, dialog);
    if (dialog === "copy") {
      set(internalWorkflowCopyDialogState$, { kind: "select" });
    }
  },
);

export const setWorkflowCopyDialogState$ = command(
  ({ set }, copyState: WorkflowCopyDialogState) => {
    set(internalWorkflowCopyDialogState$, copyState);
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
  set(internalWorkflowDetailActiveTab$, "automations");
  set(internalSelectedFilePath$, null);
  set(internalWorkflowActionDialog$, null);
  set(internalWorkflowCopyDialogState$, { kind: "select" });
  set(internalWorkflowFileDraft$, null);
  set(internalEditingWorkflowTriggerId$, null);
  set(internalWorkflowMetadataPatch$, null);
  set(internalWorkflowTriggerCreateDialog$, null);
  set(internalCreatedWorkflowWebhookTrigger$, null);
  set(internalCreateGithubLabelActor$, "me");
  set(internalEditingGithubLabelActors$, {});
  set(internalCreateScheduleCronFields$, defaultWorkflowCronFields());
  set(internalEditingScheduleCronFields$, defaultWorkflowCronFields());
});

export const workflowDetailActiveTab$ = computed((get) => {
  const route = get(activeRoute$);
  if (isWorkflowDetailRouteKey(route)) {
    return workflowDetailTabFromRoute(route);
  }
  return get(internalWorkflowDetailActiveTab$);
});

export const setWorkflowDetailActiveTab$ = command(
  ({ get, set }, tab: WorkflowDetailTab) => {
    set(internalWorkflowDetailActiveTab$, tab);
    const workflowId = get(currentWorkflowId$);
    if (!workflowId) {
      return;
    }
    set(
      replacePathSilently$,
      workflowDetailRouteForTab(tab),
      { workflowId },
      new URLSearchParams(),
    );
  },
);

export const editingWorkflowTriggerId$ = computed((get) => {
  return get(internalEditingWorkflowTriggerId$);
});

export const setEditingWorkflowTriggerId$ = command(
  ({ set }, triggerId: string | null) => {
    set(internalEditingWorkflowTriggerId$, triggerId);
    if (!triggerId) {
      set(internalEditingGithubLabelActors$, {});
    }
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
    if (dialog === "github-label") {
      set(internalCreateGithubLabelActor$, "me");
    }
  },
);

export const createGithubLabelActor$ = computed((get) => {
  return get(internalCreateGithubLabelActor$);
});

export const setCreateGithubLabelActor$ = command(
  ({ set }, actor: WorkflowGithubLabelActor) => {
    set(internalCreateGithubLabelActor$, actor);
  },
);

export const editingGithubLabelActors$ = computed((get) => {
  return get(internalEditingGithubLabelActors$);
});

export const setEditingGithubLabelActor$ = command(
  (
    { set },
    input: {
      readonly triggerId: string;
      readonly actor: WorkflowGithubLabelActor;
    },
  ) => {
    set(internalEditingGithubLabelActors$, (actors) => {
      return { ...actors, [input.triggerId]: input.actor };
    });
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
    set(internalWorkflowDetailActiveTab$, "instructions");
    const workflowId = get(currentWorkflowId$);
    if (!workflowId) {
      return;
    }
    const params = new URLSearchParams();
    if (path) {
      params.set(WORKFLOW_DETAIL_FILE_PARAM, path);
    }
    set(
      replacePathSilently$,
      ROUTES.workflowDetailInstructions,
      { workflowId },
      params,
    );
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

export const allVisibleWorkflows$ = computed(
  async (get): Promise<readonly ZeroWorkflowSummary[]> => {
    get(internalWorkflowReload$);
    const client = get(zeroClient$)(zeroWorkflowsCollectionContract);
    const result = await accept(client.list({ query: {} }), [200]);
    return [...result.body].sort((a, b) => {
      if (a.visibility !== b.visibility) {
        return a.visibility === "public" ? -1 : 1;
      }
      const aTitle = a.displayName ?? a.name;
      const bTitle = b.displayName ?? b.name;
      return aTitle.localeCompare(bTitle);
    });
  },
);

export const allWorkflowTriggerEntries$ = computed(
  async (get): Promise<readonly WorkflowTriggerAutomationEntry[]> => {
    get(internalWorkflowReload$);
    const triggerClient = get(zeroClient$)(zeroWorkflowTriggersContract);
    const triggerResult = await accept(triggerClient.listWorkspace(), [200]);
    return [...triggerResult.body].sort((a, b) => {
      if (a.trigger.enabled !== b.trigger.enabled) {
        return a.trigger.enabled ? -1 : 1;
      }
      const aNext = a.trigger.nextRunAt ?? "";
      const bNext = b.trigger.nextRunAt ?? "";
      if (aNext && bNext && aNext !== bNext) {
        return aNext.localeCompare(bNext);
      }
      if (aNext !== bNext) {
        return aNext ? -1 : 1;
      }
      const aTitle = a.workflow.displayName ?? a.workflow.name;
      const bTitle = b.workflow.displayName ?? b.workflow.name;
      return aTitle.localeCompare(bTitle);
    });
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

type WorkflowVisibilityAction = "publish" | "demote";

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
      input.action === "publish"
        ? client.publish(options)
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

export const createWorkflowGithubLabelAppliedTrigger$ = command(
  async (
    { get, set },
    input: {
      readonly workflowId: string;
      readonly eventConfig: GithubLabelAppliedEventConfig;
    },
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroWorkflowTriggersContract);
    await accept(
      client.create({
        params: { workflowId: input.workflowId },
        body: {
          kind: "event",
          eventType: "github-label-applied",
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

export const createWorkflowGoogleCalendarEventTrigger$ = command(
  async (
    { get, set },
    input:
      | {
          readonly workflowId: string;
          readonly eventType: "google-calendar-event-created";
          readonly eventConfig: GoogleCalendarEventCreatedEventConfig;
        }
      | {
          readonly workflowId: string;
          readonly eventType: "google-calendar-event-updated";
          readonly eventConfig: GoogleCalendarEventUpdatedEventConfig;
        }
      | {
          readonly workflowId: string;
          readonly eventType: "google-calendar-event-cancelled";
          readonly eventConfig: GoogleCalendarEventCancelledEventConfig;
        },
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroWorkflowTriggersContract);
    const body: ZeroWorkflowTriggerCreateRequest =
      input.eventType === "google-calendar-event-created"
        ? {
            kind: "event",
            eventType: "google-calendar-event-created",
            eventConfig: input.eventConfig,
          }
        : input.eventType === "google-calendar-event-updated"
          ? {
              kind: "event",
              eventType: "google-calendar-event-updated",
              eventConfig: input.eventConfig,
            }
          : {
              kind: "event",
              eventType: "google-calendar-event-cancelled",
              eventConfig: input.eventConfig,
            };
    await accept(
      client.create({
        params: { workflowId: input.workflowId },
        body,
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

export const updateWorkflowGithubLabelAppliedTrigger$ = command(
  async (
    { get, set },
    input: {
      readonly triggerId: string;
      readonly eventConfig: GithubLabelAppliedEventConfig;
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

export const pauseWorkflowTriggers$ = command(
  async (
    { get, set },
    triggerIds: readonly string[],
    signal: AbortSignal,
  ): Promise<{ readonly pausedCount: number }> => {
    if (triggerIds.length === 0) {
      return { pausedCount: 0 };
    }

    const client = get(zeroClient$)(zeroWorkflowTriggersContract);
    await Promise.all(
      triggerIds.map((triggerId) => {
        return accept(
          client.disable({
            params: { id: triggerId },
            fetchOptions: { signal },
          }),
          [200],
        );
      }),
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
    return { pausedCount: triggerIds.length };
  },
);

export const runWorkflowTriggerNow$ = command(
  async (
    { get },
    triggerId: string,
    signal: AbortSignal,
  ): Promise<{ chatThreadId: string; runId: string }> => {
    const client = get(zeroClient$)(zeroWorkflowTriggersContract);
    const result = await accept(
      client.run({
        params: { id: triggerId },
        fetchOptions: { signal },
      }),
      [201],
    );
    signal.throwIfAborted();
    return result.body;
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
