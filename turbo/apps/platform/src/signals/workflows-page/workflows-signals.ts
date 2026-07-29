import { command, computed, state } from "ccstate";
import {
  zeroWorkflowsCollectionContract,
  zeroWorkflowsDetailContract,
  zeroWorkflowAutomationsContract,
  zeroWorkflowVisibilityContract,
  type GmailLabelAppliedEventConfig,
  type GmailNewMessageEventConfig,
  type GoogleCalendarEventCancelledEventConfig,
  type GoogleCalendarEventCreatedEventConfig,
  type GoogleCalendarEventUpdatedEventConfig,
  type GoogleMeetTranscriptGeneratedEventConfig,
  type GithubDeploymentStatusCreatedEventConfig,
  type GithubIssueCommentCreatedEventConfig,
  type GithubLabelAppliedEventConfig,
  type GithubPullRequestReviewSubmittedEventConfig,
  type GithubWorkflowJobCompletedEventConfig,
  type GithubWorkflowRunCompletedEventConfig,
  type NotionChildPageCreatedEventCreateConfig,
  type NotionDatabaseItemCreatedEventCreateConfig,
  type NotionPageContentUpdatedEventCreateConfig,
  type StrapiEntryPublishedEventConfig,
  type ZeroWorkflowDetailResponse,
  type ZeroWorkflowConnectorReadinessResponse,
  type ZeroWorkflowSchedule,
  type ZeroWorkflowWebhookSecretResponse,
  type ZeroWorkflowSummary,
  type ZeroWorkflowAutomationsListEntry,
  type ZeroWorkflowAutomationCreateRequest,
  type ZeroWorkflowAutomationSummary,
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
import { currentAgentId$ } from "../agent.ts";
import { ensureDraft$ } from "../chat-page/create-chat-thread.ts";
import {
  reloadWorkflowData$,
  workflowReloadVersion$,
} from "./workflow-reload.ts";

type WorkflowDetailActionDialog = "copy" | "delete" | null;
export type WorkflowDetailTab = "automations" | "instructions" | "info";
export type WorkflowFilter =
  | "all"
  | "automated"
  | "without"
  | "private"
  | "public";
export type WorkflowSortMode = "next-run" | "alphabetical" | "created";
export interface WorkflowCopyFormState {
  readonly selectedAgentId: string | null;
  readonly removeOriginal: boolean;
}

export type GmailTextField = "from" | "subject" | "body" | "to" | "cc";
export type GmailTextOperator = "contains" | "containsAny" | "doesNotContain";
export type GmailMatchField = GmailTextField | "threadId";
export type GmailMatchOperator = GmailTextOperator | "is";
export interface GmailMatchCondition {
  readonly field: GmailMatchField;
  readonly operator: GmailMatchOperator;
  readonly value: string;
}

function defaultGmailMatchConditions(): readonly GmailMatchCondition[] {
  return [{ field: "from", operator: "contains", value: "" }];
}

function defaultWorkflowCopyForm(): WorkflowCopyFormState {
  return {
    selectedAgentId: null,
    removeOriginal: false,
  };
}
export type WorkflowAutomationCreateDialog =
  | "interval"
  | "scheduled"
  | "once"
  | "gmail"
  | "gmail-label"
  | "github-label"
  | "github-workflow-job"
  | "github-pull-request-review"
  | "github-deployment-status"
  | "github-issue-comment"
  | "github-workflow-run"
  | "google-calendar-created"
  | "google-calendar-updated"
  | "google-calendar-cancelled"
  | "google-meet-transcript-generated"
  | "notion-child-page"
  | "notion-database-item"
  | "notion-page-content-updated"
  | "strapi-entry-published"
  | "webhook"
  | null;
export type NotionPageContentUpdatedScopeMode = "page" | "database";
type WorkflowAutomationCategoryKey =
  | "schedule"
  | "email"
  | "calendar"
  | "notion"
  | "integrations";
type WorkflowWebhookAutomationSummary = Extract<
  ZeroWorkflowAutomationSummary,
  { readonly kind: "event"; readonly eventType: "webhook-received" }
>;
type WorkflowGithubLabelActor =
  GithubLabelAppliedEventConfig["filters"]["actor"]["type"];
export type WorkflowAutomationEntry = ZeroWorkflowAutomationsListEntry;
const WORKFLOW_DETAIL_FILE_PARAM = "file";

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

function workflowDetailRouteForTab(
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

const internalWorkflowDetailActiveTab$ =
  state<WorkflowDetailTab>("automations");

const internalSelectedFilePath$ = state<string | null>(null);
const internalWorkflowActionDialog$ = state<WorkflowDetailActionDialog>(null);
const internalWorkflowDemoteConfirmOpen$ = state<boolean>(false);
const internalWorkflowCopyForm$ = state<WorkflowCopyFormState>(
  defaultWorkflowCopyForm(),
);
const internalWorkflowFileDraft$ = state<WorkflowDetailFileDraft | null>(null);
const internalEditingWorkflowAutomationId$ = state<string | null>(null);
const internalWorkflowMetadataPatch$ = state<WorkflowMetadataPatch | null>(
  null,
);
const internalWorkflowAutomationCreateDialog$ =
  state<WorkflowAutomationCreateDialog>(null);
const internalCreatedWorkflowWebhookAutomation$ =
  state<WorkflowWebhookAutomationSummary | null>(null);
const internalWorkflowAutomationPickerOpen$ = state(false);
const internalWorkflowWebhookUpgradeDialogOpen$ = state(false);
const internalCreateStrapiIntegrationId$ = state<string | null>(null);
const internalWorkflowAutomationPickerCategory$ =
  state<WorkflowAutomationCategoryKey>("schedule");
const internalCreateNotionPageContentUpdatedScope$ =
  state<NotionPageContentUpdatedScopeMode>("page");
const internalRevealWebhookSecretAutomationId$ = state<string | null>(null);
const internalCreateGithubLabelActor$ = state<WorkflowGithubLabelActor>("me");
const internalEditingGithubLabelActors$ = state<
  Record<string, WorkflowGithubLabelActor>
>({});
const internalCreateGmailMatchConditions$ = state<
  readonly GmailMatchCondition[]
>(defaultGmailMatchConditions());
const internalEditingGmailMatchConditions$ = state<
  Readonly<Record<string, readonly GmailMatchCondition[]>>
>({});
const internalCreateScheduleCronFields$ = state<WorkflowCronFields>(
  defaultWorkflowCronFields(),
);
const internalEditingScheduleCronFields$ = state<WorkflowCronFields>(
  defaultWorkflowCronFields(),
);
type WorkflowConnectorReadinessState =
  | {
      readonly workflowId: string;
      readonly requestId: string;
      readonly status: "pending";
    }
  | {
      readonly workflowId: string;
      readonly requestId: string;
      readonly status: "error";
      readonly errorKind: "input-too-long" | "timeout" | "retry";
    }
  | {
      readonly workflowId: string;
      readonly requestId: string;
      readonly status: "success";
      readonly response: ZeroWorkflowConnectorReadinessResponse;
    };

const internalWorkflowConnectorReadiness$ =
  state<WorkflowConnectorReadinessState | null>(null);

export const workflowActionDialog$ = computed((get) => {
  return get(internalWorkflowActionDialog$);
});

export const workflowDemoteConfirmOpen$ = computed((get) => {
  return get(internalWorkflowDemoteConfirmOpen$);
});

export const setWorkflowDemoteConfirmOpen$ = command(
  ({ set }, open: boolean) => {
    set(internalWorkflowDemoteConfirmOpen$, open);
  },
);

export const workflowCopyForm$ = computed((get) => {
  return get(internalWorkflowCopyForm$);
});

const FILTER_PARAM = "filter";
const SORT_MODE_PARAM = "sort";
const AGENT_PARAM = "agent";

/** The sentinel agent-filter value that clears the agent scope. */
export const WORKFLOW_ALL_AGENTS = "all";

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

export const workflowFilter$ = computed((get): WorkflowFilter => {
  return readSearchParam(
    get(searchParams$),
    FILTER_PARAM,
    ["all", "automated", "without", "private", "public"],
    "all",
  );
});

export const workflowSortMode$ = computed((get): WorkflowSortMode => {
  return readSearchParam(
    get(searchParams$),
    SORT_MODE_PARAM,
    ["next-run", "alphabetical", "created"],
    "next-run",
  );
});

/**
 * The agent the list is scoped to, keyed by agent uuid, or `WORKFLOW_ALL_AGENTS`
 * when unscoped. The value is validated against the visible agents in the view,
 * so an unknown id simply yields an empty list.
 */
export const workflowAgentFilter$ = computed((get): string => {
  return get(searchParams$).get(AGENT_PARAM) ?? WORKFLOW_ALL_AGENTS;
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

export const setWorkflowFilter$ = command(
  ({ get, set }, value: WorkflowFilter) => {
    set(
      replaceSearchParams$,
      nextSearchParams(get(searchParams$), FILTER_PARAM, value, "all"),
    );
  },
);

export const setWorkflowSortMode$ = command(
  ({ get, set }, value: WorkflowSortMode) => {
    set(
      replaceSearchParams$,
      nextSearchParams(get(searchParams$), SORT_MODE_PARAM, value, "next-run"),
    );
  },
);

export const setWorkflowAgentFilter$ = command(
  ({ get, set }, value: string) => {
    set(
      replaceSearchParams$,
      nextSearchParams(
        get(searchParams$),
        AGENT_PARAM,
        value,
        WORKFLOW_ALL_AGENTS,
      ),
    );
  },
);

export const setWorkflowActionDialog$ = command(
  ({ set }, dialog: WorkflowDetailActionDialog) => {
    set(internalWorkflowActionDialog$, dialog);
    set(internalWorkflowCopyForm$, defaultWorkflowCopyForm());
  },
);

export const setWorkflowCopyForm$ = command(
  ({ set }, form: WorkflowCopyFormState) => {
    set(internalWorkflowCopyForm$, form);
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

export const workflowConnectorReadiness$ = computed((get) => {
  return get(internalWorkflowConnectorReadiness$);
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
  set(internalWorkflowCopyForm$, defaultWorkflowCopyForm());
  set(internalWorkflowFileDraft$, null);
  set(internalEditingWorkflowAutomationId$, null);
  set(internalWorkflowMetadataPatch$, null);
  set(internalWorkflowAutomationCreateDialog$, null);
  set(internalCreatedWorkflowWebhookAutomation$, null);
  set(internalCreateGithubLabelActor$, "me");
  set(internalEditingGithubLabelActors$, {});
  set(internalCreateGmailMatchConditions$, defaultGmailMatchConditions());
  set(internalEditingGmailMatchConditions$, {});
  set(internalCreateScheduleCronFields$, defaultWorkflowCronFields());
  set(internalEditingScheduleCronFields$, defaultWorkflowCronFields());
  set(internalWorkflowConnectorReadiness$, null);
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

export const editingWorkflowAutomationId$ = computed((get) => {
  return get(internalEditingWorkflowAutomationId$);
});

export const setEditingWorkflowAutomationId$ = command(
  ({ set }, automationId: string | null) => {
    set(internalEditingWorkflowAutomationId$, automationId);
    if (!automationId) {
      set(internalEditingGithubLabelActors$, {});
      set(internalEditingGmailMatchConditions$, {});
    }
  },
);

export const workflowAutomationCreateDialog$ = computed((get) => {
  return get(internalWorkflowAutomationCreateDialog$);
});

export const createdWorkflowWebhookAutomation$ = computed((get) => {
  return get(internalCreatedWorkflowWebhookAutomation$);
});

export const setCreatedWorkflowWebhookAutomation$ = command(
  ({ set }, automation: WorkflowWebhookAutomationSummary | null) => {
    set(internalCreatedWorkflowWebhookAutomation$, automation);
  },
);

export const revealWebhookSecretAutomationId$ = computed((get) => {
  return get(internalRevealWebhookSecretAutomationId$);
});

export const setRevealWebhookSecretAutomationId$ = command(
  ({ set }, automationId: string | null) => {
    set(internalRevealWebhookSecretAutomationId$, automationId);
  },
);

export const setWorkflowAutomationCreateDialog$ = command(
  ({ set }, dialog: WorkflowAutomationCreateDialog) => {
    set(internalWorkflowAutomationCreateDialog$, dialog);
    if (dialog !== "webhook") {
      set(internalCreatedWorkflowWebhookAutomation$, null);
    }
    if (dialog === "scheduled") {
      set(internalCreateScheduleCronFields$, defaultWorkflowCronFields());
    }
    if (dialog === "github-label") {
      set(internalCreateGithubLabelActor$, "me");
    }
    if (dialog === "gmail") {
      set(internalCreateGmailMatchConditions$, defaultGmailMatchConditions());
    }
    if (dialog === "notion-page-content-updated") {
      set(internalCreateNotionPageContentUpdatedScope$, "page");
    }
  },
);

export const workflowAutomationPickerOpen$ = computed((get) => {
  return get(internalWorkflowAutomationPickerOpen$);
});

export const setWorkflowAutomationPickerOpen$ = command(
  ({ set }, open: boolean) => {
    set(internalWorkflowAutomationPickerOpen$, open);
    // Reset to the first category each time the picker opens.
    if (open) {
      set(internalWorkflowAutomationPickerCategory$, "schedule");
    }
  },
);

export const workflowWebhookUpgradeDialogOpen$ = computed((get) => {
  return get(internalWorkflowWebhookUpgradeDialogOpen$);
});

export const setWorkflowWebhookUpgradeDialogOpen$ = command(
  ({ set }, open: boolean) => {
    set(internalWorkflowWebhookUpgradeDialogOpen$, open);
  },
);

export const workflowAutomationPickerCategory$ = computed((get) => {
  return get(internalWorkflowAutomationPickerCategory$);
});

export const setWorkflowAutomationPickerCategory$ = command(
  ({ set }, category: WorkflowAutomationCategoryKey) => {
    set(internalWorkflowAutomationPickerCategory$, category);
  },
);

export const createNotionPageContentUpdatedScope$ = computed((get) => {
  return get(internalCreateNotionPageContentUpdatedScope$);
});

export const createStrapiIntegrationId$ = computed((get) => {
  return get(internalCreateStrapiIntegrationId$);
});

export const setCreateStrapiIntegrationId$ = command(
  ({ set }, integrationId: string | null) => {
    set(internalCreateStrapiIntegrationId$, integrationId);
  },
);

export const setCreateNotionPageContentUpdatedScope$ = command(
  ({ set }, scope: NotionPageContentUpdatedScopeMode) => {
    set(internalCreateNotionPageContentUpdatedScope$, scope);
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
      readonly automationId: string;
      readonly actor: WorkflowGithubLabelActor;
    },
  ) => {
    set(internalEditingGithubLabelActors$, (actors) => {
      return { ...actors, [input.automationId]: input.actor };
    });
  },
);

export const createGmailMatchConditions$ = computed((get) => {
  return get(internalCreateGmailMatchConditions$);
});

export const setCreateGmailMatchConditions$ = command(
  ({ set }, conditions: readonly GmailMatchCondition[]) => {
    set(internalCreateGmailMatchConditions$, conditions);
  },
);

export const editingGmailMatchConditions$ = computed((get) => {
  return get(internalEditingGmailMatchConditions$);
});

export const setEditingGmailMatchConditions$ = command(
  (
    { set },
    input: {
      readonly automationId: string;
      readonly conditions: readonly GmailMatchCondition[];
    },
  ) => {
    set(internalEditingGmailMatchConditions$, {
      [input.automationId]: input.conditions,
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
  set(reloadWorkflowData$);
  set(internalWorkflowConnectorReadiness$, null);
});

/** The current agent detail route's visible workflows. */
export const currentAgentVisibleWorkflows$ = computed(
  async (get): Promise<readonly ZeroWorkflowSummary[]> => {
    get(workflowReloadVersion$);
    const agentId = get(currentAgentId$);
    if (!agentId) {
      return [];
    }
    const client = get(zeroClient$)(zeroWorkflowsCollectionContract);
    const result = await accept(client.list({ query: { agentId } }), [200]);
    return result.body;
  },
);

export const allVisibleWorkflows$ = computed(
  async (get): Promise<readonly ZeroWorkflowSummary[]> => {
    get(workflowReloadVersion$);
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

export const allWorkflowAutomationEntries$ = computed(
  async (get): Promise<readonly WorkflowAutomationEntry[]> => {
    get(workflowReloadVersion$);
    const automationClient = get(zeroClient$)(zeroWorkflowAutomationsContract);
    const automationResult = await accept(
      automationClient.listWorkspace(),
      [200],
    );
    return [...automationResult.body].sort((a, b) => {
      if (a.automation.enabled !== b.automation.enabled) {
        return a.automation.enabled ? -1 : 1;
      }
      const aNext = a.automation.nextRunAt ?? "";
      const bNext = b.automation.nextRunAt ?? "";
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

/** The workflow detail derived from the active route. */
export const currentWorkflowDetail$ = computed(
  async (get): Promise<ZeroWorkflowDetailResponse | null> => {
    get(workflowReloadVersion$);
    const workflowId = get(currentWorkflowId$);
    if (!workflowId) {
      return null;
    }
    const client = get(zeroClient$)(zeroWorkflowsDetailContract);
    const result = await accept(
      client.get({ params: { workflowId } }),
      [200, 404],
    );
    return result.status === 404 ? null : result.body;
  },
);

export const checkWorkflowConnectorReadiness$ = command(
  async ({ get, set }, workflowId: string, signal: AbortSignal) => {
    const requestId = crypto.randomUUID();
    set(internalWorkflowConnectorReadiness$, {
      workflowId,
      requestId,
      status: "pending",
    });
    const client = get(zeroClient$)(zeroWorkflowsDetailContract);
    const result = await accept(
      client.connectorReadiness({
        params: { workflowId },
        fetchOptions: { signal },
      }),
      [200, 413, 503],
    );
    signal.throwIfAborted();
    if (get(internalWorkflowConnectorReadiness$)?.requestId !== requestId) {
      return;
    }
    if (result.status !== 200) {
      set(internalWorkflowConnectorReadiness$, {
        workflowId,
        requestId,
        status: "error",
        errorKind:
          result.status === 413
            ? "input-too-long"
            : result.body.error.code === "CONNECTOR_READINESS_TIMEOUT"
              ? "timeout"
              : "retry",
      });
      return;
    }
    set(internalWorkflowConnectorReadiness$, {
      workflowId,
      requestId,
      status: "success",
      response: result.body,
    });
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

export const createWorkflowScheduleAutomation$ = command(
  async (
    { get, set },
    input: { workflowId: string; schedule: ZeroWorkflowSchedule },
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroWorkflowAutomationsContract);
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

export const createWorkflowGmailNewMessageAutomation$ = command(
  async (
    { get, set },
    input: {
      readonly workflowId: string;
      readonly eventConfig: GmailNewMessageEventConfig;
    },
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroWorkflowAutomationsContract);
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

export const createWorkflowGmailLabelAppliedAutomation$ = command(
  async (
    { get, set },
    input: {
      readonly workflowId: string;
      readonly eventConfig: GmailLabelAppliedEventConfig;
    },
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroWorkflowAutomationsContract);
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

export const createWorkflowGithubLabelAppliedAutomation$ = command(
  async (
    { get, set },
    input: {
      readonly workflowId: string;
      readonly eventConfig: GithubLabelAppliedEventConfig;
    },
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroWorkflowAutomationsContract);
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

export const createWorkflowGithubWorkflowRunCompletedAutomation$ = command(
  async (
    { get, set },
    input: {
      readonly workflowId: string;
      readonly eventConfig: GithubWorkflowRunCompletedEventConfig;
    },
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroWorkflowAutomationsContract);
    await accept(
      client.create({
        params: { workflowId: input.workflowId },
        body: {
          kind: "event",
          eventType: "github-workflow-run-completed",
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

type GithubWebhookAutomationCreateInput =
  | {
      readonly workflowId: string;
      readonly eventType: "github-workflow-job-completed";
      readonly eventConfig: GithubWorkflowJobCompletedEventConfig;
    }
  | {
      readonly workflowId: string;
      readonly eventType: "github-pull-request-review-submitted";
      readonly eventConfig: GithubPullRequestReviewSubmittedEventConfig;
    }
  | {
      readonly workflowId: string;
      readonly eventType: "github-deployment-status-created";
      readonly eventConfig: GithubDeploymentStatusCreatedEventConfig;
    }
  | {
      readonly workflowId: string;
      readonly eventType: "github-issue-comment-created";
      readonly eventConfig: GithubIssueCommentCreatedEventConfig;
    };

export const createWorkflowGithubWebhookAutomation$ = command(
  async (
    { get, set },
    input: GithubWebhookAutomationCreateInput,
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroWorkflowAutomationsContract);
    const body: ZeroWorkflowAutomationCreateRequest =
      input.eventType === "github-workflow-job-completed"
        ? {
            kind: "event",
            eventType: input.eventType,
            eventConfig: input.eventConfig,
          }
        : input.eventType === "github-pull-request-review-submitted"
          ? {
              kind: "event",
              eventType: input.eventType,
              eventConfig: input.eventConfig,
            }
          : input.eventType === "github-deployment-status-created"
            ? {
                kind: "event",
                eventType: input.eventType,
                eventConfig: input.eventConfig,
              }
            : {
                kind: "event",
                eventType: input.eventType,
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

export const createWorkflowGoogleCalendarEventAutomation$ = command(
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
    const client = get(zeroClient$)(zeroWorkflowAutomationsContract);
    const body: ZeroWorkflowAutomationCreateRequest =
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

export const createWorkflowGoogleMeetTranscriptGeneratedAutomation$ = command(
  async (
    { get, set },
    input: {
      readonly workflowId: string;
      readonly eventConfig?: GoogleMeetTranscriptGeneratedEventConfig;
    },
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroWorkflowAutomationsContract);
    await accept(
      client.create({
        params: { workflowId: input.workflowId },
        body: {
          kind: "event",
          eventType: "google-meet-transcript-generated",
          eventConfig: input.eventConfig ?? {
            provider: "google-meet",
            event: "transcript_generated",
            scope: { type: "organizer_user" },
          },
        },
        fetchOptions: { signal },
      }),
      [201],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
  },
);

export const createWorkflowNotionChildPageAutomation$ = command(
  async (
    { get, set },
    input: {
      readonly workflowId: string;
      readonly eventConfig: NotionChildPageCreatedEventCreateConfig;
    },
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroWorkflowAutomationsContract);
    await accept(
      client.create({
        params: { workflowId: input.workflowId },
        body: {
          kind: "event",
          eventType: "notion-child-page-created",
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

export const createWorkflowNotionDatabaseItemAutomation$ = command(
  async (
    { get, set },
    input: {
      readonly workflowId: string;
      readonly eventConfig: NotionDatabaseItemCreatedEventCreateConfig;
    },
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroWorkflowAutomationsContract);
    await accept(
      client.create({
        params: { workflowId: input.workflowId },
        body: {
          kind: "event",
          eventType: "notion-database-item-created",
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

export const createWorkflowNotionPageContentUpdatedAutomation$ = command(
  async (
    { get, set },
    input: {
      readonly workflowId: string;
      readonly eventConfig: NotionPageContentUpdatedEventCreateConfig;
    },
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroWorkflowAutomationsContract);
    await accept(
      client.create({
        params: { workflowId: input.workflowId },
        body: {
          kind: "event",
          eventType: "notion-page-content-updated",
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

export const createWorkflowStrapiEntryPublishedAutomation$ = command(
  async (
    { get, set },
    input: {
      readonly workflowId: string;
      readonly eventConfig: StrapiEntryPublishedEventConfig;
    },
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroWorkflowAutomationsContract);
    await accept(
      client.create({
        params: { workflowId: input.workflowId },
        body: {
          kind: "event",
          eventType: "strapi-entry-published",
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

export const createWorkflowWebhookAutomation$ = command(
  async (
    { get, set },
    input: { readonly workflowId: string },
    signal: AbortSignal,
  ): Promise<WorkflowWebhookAutomationSummary | null> => {
    const client = get(zeroClient$)(zeroWorkflowAutomationsContract);
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
      [201, 402],
    );
    signal.throwIfAborted();
    if (result.status === 402) {
      if (result.body.error.code === "TEAM_REQUIRED") {
        set(internalWorkflowWebhookUpgradeDialogOpen$, true);
        return null;
      }
      throw new Error(result.body.error.message);
    }
    if (
      result.body.kind !== "event" ||
      result.body.eventType !== "webhook-received"
    ) {
      throw new Error("Expected webhook workflow automation summary");
    }
    return result.body;
  },
);

export const revealWorkflowWebhookSecret$ = command(
  async (
    { get },
    input: { readonly automationId: string },
    signal: AbortSignal,
  ): Promise<ZeroWorkflowWebhookSecretResponse> => {
    const client = get(zeroClient$)(zeroWorkflowAutomationsContract);
    const result = await accept(
      client.revealWebhookSecret({
        params: { id: input.automationId },
        body: undefined,
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    return result.body;
  },
);

export const updateWorkflowGmailNewMessageAutomation$ = command(
  async (
    { get, set },
    input: {
      readonly automationId: string;
      readonly eventConfig: GmailNewMessageEventConfig;
    },
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroWorkflowAutomationsContract);
    await accept(
      client.update({
        params: { id: input.automationId },
        body: { eventConfig: input.eventConfig },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
  },
);

export const updateWorkflowGmailLabelAppliedAutomation$ = command(
  async (
    { get, set },
    input: {
      readonly automationId: string;
      readonly eventConfig: GmailLabelAppliedEventConfig;
    },
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroWorkflowAutomationsContract);
    await accept(
      client.update({
        params: { id: input.automationId },
        body: { eventConfig: input.eventConfig },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
  },
);

export const updateWorkflowGithubLabelAppliedAutomation$ = command(
  async (
    { get, set },
    input: {
      readonly automationId: string;
      readonly eventConfig: GithubLabelAppliedEventConfig;
    },
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroWorkflowAutomationsContract);
    await accept(
      client.update({
        params: { id: input.automationId },
        body: { eventConfig: input.eventConfig },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
  },
);

export const updateWorkflowGithubWorkflowRunCompletedAutomation$ = command(
  async (
    { get, set },
    input: {
      readonly automationId: string;
      readonly eventConfig: GithubWorkflowRunCompletedEventConfig;
    },
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroWorkflowAutomationsContract);
    await accept(
      client.update({
        params: { id: input.automationId },
        body: { eventConfig: input.eventConfig },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
  },
);

export const updateWorkflowGithubWebhookAutomation$ = command(
  async (
    { get, set },
    input: {
      readonly automationId: string;
      readonly eventConfig:
        | GithubWorkflowJobCompletedEventConfig
        | GithubPullRequestReviewSubmittedEventConfig
        | GithubDeploymentStatusCreatedEventConfig
        | GithubIssueCommentCreatedEventConfig;
    },
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroWorkflowAutomationsContract);
    await accept(
      client.update({
        params: { id: input.automationId },
        body: { eventConfig: input.eventConfig },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
  },
);

export const updateWorkflowScheduleAutomation$ = command(
  async (
    { get, set },
    input: {
      readonly automationId: string;
      readonly schedule: ZeroWorkflowSchedule;
    },
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroWorkflowAutomationsContract);
    await accept(
      client.update({
        params: { id: input.automationId },
        body: { schedule: input.schedule },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
  },
);

export const setWorkflowAutomationEnabled$ = command(
  async (
    { get, set },
    input: { automationId: string; enabled: boolean },
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroWorkflowAutomationsContract);
    const request = input.enabled
      ? client.enable({
          params: { id: input.automationId },
          fetchOptions: { signal },
        })
      : client.disable({
          params: { id: input.automationId },
          fetchOptions: { signal },
        });
    const result = await accept(request, [200, 402]);
    signal.throwIfAborted();
    if (result.status === 402) {
      if (result.body.error.code === "TEAM_REQUIRED") {
        set(internalWorkflowWebhookUpgradeDialogOpen$, true);
        return;
      }
      throw new Error(result.body.error.message);
    }
    set(reloadWorkflows$);
  },
);

export const pauseWorkflowAutomations$ = command(
  async (
    { get, set },
    automationIds: readonly string[],
    signal: AbortSignal,
  ): Promise<{ readonly pausedCount: number }> => {
    if (automationIds.length === 0) {
      return { pausedCount: 0 };
    }

    const client = get(zeroClient$)(zeroWorkflowAutomationsContract);
    await Promise.all(
      automationIds.map((automationId) => {
        return accept(
          client.disable({
            params: { id: automationId },
            fetchOptions: { signal },
          }),
          [200],
        );
      }),
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
    return { pausedCount: automationIds.length };
  },
);

export const runWorkflowAutomationNow$ = command(
  async (
    { get },
    automationId: string,
    signal: AbortSignal,
  ): Promise<{ chatThreadId: string; runId: string | null }> => {
    const client = get(zeroClient$)(zeroWorkflowAutomationsContract);
    const result = await accept(
      client.run({
        params: { id: automationId },
        fetchOptions: { signal },
      }),
      [201],
    );
    signal.throwIfAborted();
    return result.body;
  },
);

export const deleteWorkflowAutomation$ = command(
  async ({ get, set }, automationId: string, signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroWorkflowAutomationsContract);
    await accept(
      client.delete({ params: { id: automationId }, fetchOptions: { signal } }),
      [204],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
  },
);
