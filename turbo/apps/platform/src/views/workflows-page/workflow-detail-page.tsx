// Agent-scoped workflow detail at /agents/:agentId/workflows/:workflowId. Hosts
// the instruction editor, supplementary file manager (SKILL.md is never shown),
// triggers, visibility controls, metadata editing, slash use, copy, and delete.
import type { FormEvent, ReactNode } from "react";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useLoadable,
  useSet,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type {
  GmailLabelAppliedEventConfig,
  GmailNewMessageEventConfig,
  WorkflowFileEntry,
  WorkflowFileMetadata,
  ZeroWorkflowDetailResponse,
  ZeroWorkflowSchedule,
  ZeroWorkflowScheduleType,
  ZeroWorkflowTriggerSummary,
  ZeroWorkflowUpdateRequest,
} from "@vm0/api-contracts/contracts/zero-workflows";
import {
  IconAlertTriangle,
  IconChevronDown,
  IconClock,
  IconCopy,
  IconFileText,
  IconInfoCircle,
  IconLink,
  IconLoader2,
  IconMail,
  IconMessageCircle,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlus,
  IconRepeat,
  IconShieldLock,
  IconTrash,
  IconUpload,
  IconUsers,
} from "@tabler/icons-react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@vm0/ui";
import type { ConnectorType } from "@vm0/connectors/connectors";
import { permissionGrantsToFirewallPolicies } from "@vm0/connectors/firewall-metadata";
import {
  UNKNOWN_PERMISSION_GRANT,
  type FirewallPolicies,
} from "@vm0/connectors/firewall-types";

import { agents$ } from "../../signals/agent.ts";
import { user$ } from "../../signals/auth.ts";
import {
  changeWorkflowVisibility$,
  createWorkflowGmailLabelAppliedTrigger$,
  createWorkflowGmailNewMessageTrigger$,
  createWorkflowWebhookTrigger$,
  createScheduleCronFields$,
  createWorkflowScheduleTrigger$,
  createdWorkflowWebhookTrigger$,
  currentWorkflowId$,
  copyWorkflow$,
  defaultWorkflowCronFields,
  deleteWorkflow$,
  deleteWorkflowTrigger$,
  editingScheduleCronFields$,
  editingWorkflowTriggerId$,
  patchWorkflowMetadataForm$,
  openWorkflowChat$,
  reloadWorkflows$,
  resetWorkflowMetadataForm$,
  runWorkflowTriggerNow$,
  selectedWorkflowFilePath$,
  setCreateScheduleCronFields$,
  setCreatedWorkflowWebhookTrigger$,
  setEditingScheduleCronFields$,
  setEditingWorkflowTriggerId$,
  setSelectedWorkflowFilePath$,
  setWorkflowActionDialog$,
  setWorkflowAuthorizedConnectors$,
  setWorkflowDetailActiveTab$,
  setWorkflowFileDraft$,
  setWorkflowTriggerCreateDialog$,
  setWorkflowTriggerEnabled$,
  updateWorkflowGmailNewMessageTrigger$,
  updateWorkflowGmailLabelAppliedTrigger$,
  updateWorkflowScheduleTrigger$,
  updateWorkflow$,
  workflowActionDialog$,
  workflowAuthorizedConnectors,
  workflowDetailActiveTab$,
  workflowTriggerCreateDialog$,
  workflowFileDraft$,
  workflowDetail,
  type WorkflowCronFields,
  type WorkflowCronFrequency,
  type WorkflowDetailTab,
  workflowMetadataPatch$,
} from "../../signals/workflows-page/workflows-signals.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import {
  orgMembers$,
  type OrgMember,
} from "../../signals/external/org-members.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import {
  detachedNavigateTo$,
  replaceSearchParams$,
  searchParams$,
} from "../../signals/route.ts";
import { bestEffort, detach, Reason } from "../../signals/utils.ts";
import { writeToClipboard } from "../../signals/zero-page/clipboard.ts";
import {
  atTimeInTimezone,
  buildCronExpression,
  cronWallTimeInTimezone,
  type CronTimeOption,
} from "../../signals/zero-page/cron.ts";
import { userPreferences$ } from "../../signals/zero-page/settings/user-preferences.ts";
import { Link } from "../router/link.tsx";
import {
  DetailPageBreadcrumbBar,
  DetailPageHeader,
  DetailPageMain,
  DetailPageShell,
} from "../components/detail-page-layout.tsx";
import { TiptapInstructionsEditor } from "../zero-page/tiptap-instructions-editor.tsx";
import { ZeroUnsavedBar } from "../zero-page/zero-unsaved-bar.tsx";
import { InlineSettingsRow } from "../zero-page/components/zero-inline-settings-row.tsx";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  applyUserPermissionGrants$,
  userPermissionGrantsByWorkflow,
} from "../../signals/permission-allow/permission-allow-signals.ts";
import {
  savePermissionDraftPolicies,
  type ApplyUserPermissionGrants,
} from "../../signals/zero-page/settings/permission-grant-save.ts";
import {
  createEmptyPermissionDraftIntent,
  setPermissionDraftExpiration,
  setPermissionDraftPolicy,
  setPermissionDraftUnknownExpiration,
  setPermissionDraftUnknownPolicy,
  type PermissionDraftIntent,
} from "../../signals/zero-page/settings/permission-draft-intent.ts";
import { parseUserPermissionGrantExpiresIn } from "../../signals/permission-allow/permission-grant-expiration.ts";
import {
  allConnectorTypes$,
  matchesConnectorSearch,
} from "../../signals/zero-page/settings/connectors.ts";
import {
  permConnectorType$,
  permSavingType$,
  permSearch$,
  permSearchActive$,
  setPermConnectorType$,
  setPermSavingType$,
  setPermSearch$,
  setPermSearchActive$,
} from "../../signals/zero-page/zero-job-detail-page.ts";
import {
  AgentPermissionsDrawer,
  ConnectedConnectorPermissions,
  NoConnectedConnectors,
  PermissionGrantsError,
  PermissionListSkeleton,
} from "../team-page/zero-job-detail-page.tsx";
import {
  agentLabel,
  formatWorkflowIntervalSeconds,
  getWorkflowIntervalSecondOptions,
  isMarkdownPath,
  workflowTitle,
} from "./workflow-shared.tsx";
import {
  WorkflowTriggerCard,
  type WorkflowTriggerCardRow,
} from "./workflow-trigger-card.tsx";

const FIELD_CLASS =
  "h-9 w-full rounded-md border border-border/60 bg-background px-2.5 text-sm outline-none focus:border-primary";
const TRIGGER_FIELD_CLASS =
  "h-8 w-full rounded-md border border-border/60 bg-background px-2 text-xs";
const WORKFLOW_EDIT_TEXTAREA_CLASS =
  "min-h-24 w-full resize-y rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-input px-3 py-2 text-sm text-foreground placeholder:text-sm placeholder:text-muted-foreground outline-none transition-colors focus:border-primary focus:ring-[3px] focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-50";
const TRIGGER_TIMEZONE = "UTC";

type GmailMatchRules = NonNullable<GmailNewMessageEventConfig["match"]>;
type GmailTextMatcher = NonNullable<GmailMatchRules["from"]>;
type GmailTextField = "from" | "subject" | "body" | "to" | "cc";
type GmailWorkflowTriggerSummary = Extract<
  ZeroWorkflowTriggerSummary,
  {
    readonly kind: "event";
    readonly eventType: "gmail-new-message" | "gmail-label-applied";
  }
>;
type WebhookWorkflowTriggerSummary = Extract<
  ZeroWorkflowTriggerSummary,
  { readonly kind: "event"; readonly eventType: "webhook-received" }
>;

const GMAIL_TEXT_FIELDS: readonly {
  readonly field: GmailTextField;
  readonly label: string;
}[] = [
  { field: "from", label: "From" },
  { field: "subject", label: "Subject" },
  { field: "body", label: "Body" },
  { field: "to", label: "To" },
  { field: "cc", label: "Cc" },
];

const WORKFLOW_CRON_FREQUENCY_OPTIONS: readonly {
  readonly value: WorkflowCronFrequency;
  readonly label: string;
}[] = [
  { value: "every_day", label: "Every day" },
  { value: "every_weekday", label: "Every weekday" },
  { value: "every_week", label: "Every week" },
  { value: "every_month", label: "Every month" },
  { value: "custom", label: "Custom cron" },
];

const WORKFLOW_CRON_HOUR_OPTIONS: readonly number[] = Array.from(
  { length: 24 },
  (_, index) => {
    return index;
  },
);

const WORKFLOW_CRON_MINUTE_OPTIONS: readonly number[] = Array.from(
  { length: 12 },
  (_, index) => {
    return index * 5;
  },
);

const WORKFLOW_DAY_OF_WEEK_OPTIONS = [
  ["1", "Mon"],
  ["2", "Tue"],
  ["3", "Wed"],
  ["4", "Thu"],
  ["5", "Fri"],
  ["6", "Sat"],
  ["0", "Sun"],
] as const;

const WORKFLOW_CRON_FREQUENCY_TO_TIME_OPTION: Readonly<
  Record<Exclude<WorkflowCronFrequency, "custom">, CronTimeOption>
> = Object.freeze({
  every_day: "every-day",
  every_weekday: "every-weekday",
  every_week: "every-week",
  every_month: "every-month",
});

function isGmailWorkflowTrigger(
  trigger: ZeroWorkflowTriggerSummary,
): trigger is GmailWorkflowTriggerSummary {
  return (
    trigger.kind === "event" &&
    (trigger.eventType === "gmail-new-message" ||
      trigger.eventType === "gmail-label-applied")
  );
}

function isWebhookWorkflowTrigger(
  trigger: ZeroWorkflowTriggerSummary,
): trigger is WebhookWorkflowTriggerSummary {
  return trigger.kind === "event" && trigger.eventType === "webhook-received";
}

function copyText(value: string): void {
  detach(writeToClipboard(value), Reason.DomCallback);
}

interface WorkflowPermissionDeepLink {
  readonly connectorRef: string;
  readonly initialIntent?: PermissionDraftIntent;
  readonly initialSearch?: string;
  readonly initialContextKey: string;
}

function workflowPermissionDeepLinkFromSearchParams(
  params: URLSearchParams,
): WorkflowPermissionDeepLink | null {
  const connectorRef = params.get("ref");
  if (!connectorRef) {
    return null;
  }
  const permission = params.get("permission")?.trim() ?? "";
  const actionParam = params.get("action");
  const action =
    actionParam === "allow" || actionParam === "deny" ? actionParam : null;
  const expiresIn = parseUserPermissionGrantExpiresIn(params.get("expiresIn"));
  let initialIntent: PermissionDraftIntent | undefined;

  if (permission && action) {
    const policy = action === "allow" ? "allow" : "deny";
    const draft =
      permission === UNKNOWN_PERMISSION_GRANT
        ? setPermissionDraftUnknownPolicy({
            draft: createEmptyPermissionDraftIntent(),
            policy,
          })
        : setPermissionDraftPolicy({
            draft: createEmptyPermissionDraftIntent(),
            permissionName: permission,
            policy,
          });
    initialIntent =
      action === "allow" && expiresIn
        ? permission === UNKNOWN_PERMISSION_GRANT
          ? setPermissionDraftUnknownExpiration({
              draft,
              expiresIn,
            })
          : setPermissionDraftExpiration({
              draft,
              permissionName: permission,
              expiresIn,
            })
        : draft;
  }

  return {
    connectorRef,
    ...(initialIntent ? { initialIntent } : {}),
    ...(permission ? { initialSearch: permission } : {}),
    initialContextKey: JSON.stringify({
      ref: connectorRef,
      permission,
      action: actionParam,
      expiresIn: params.get("expiresIn"),
    }),
  };
}

function workflowSearchParamsWithoutPermissionDeepLink(
  params: URLSearchParams,
): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete("ref");
  next.delete("permission");
  next.delete("action");
  next.delete("expiresIn");
  return next;
}

export function WorkflowDetailPage() {
  const workflowId = useGet(currentWorkflowId$);

  if (!workflowId) {
    return null;
  }

  return <WorkflowDetailContent workflowId={workflowId} />;
}

function WorkflowDetailContent({
  workflowId,
}: {
  readonly workflowId: string;
}) {
  const detailLoadable = useLoadable(workflowDetail(workflowId));
  const detail =
    detailLoadable.state === "hasData" ? detailLoadable.data : null;
  const activeTab = useGet(workflowDetailActiveTab$);
  const setActiveTab = useSet(setWorkflowDetailActiveTab$);

  if (!detail && detailLoadable.state !== "hasData") {
    return <DetailSkeleton />;
  }

  return (
    <DetailPageShell>
      <WorkflowBreadcrumb detail={detail} />
      <DetailHeader
        detail={detail}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />
      <DetailPageMain>
        {detail ? (
          <WorkflowTabContent activeTab={activeTab} detail={detail} />
        ) : (
          <p className="text-sm text-muted-foreground">Workflow not found.</p>
        )}
      </DetailPageMain>
    </DetailPageShell>
  );
}

function WorkflowBreadcrumb({
  detail,
}: {
  readonly detail: ZeroWorkflowDetailResponse | null;
}) {
  if (!detail) {
    return (
      <DetailPageBreadcrumbBar>
        <div className="h-7 w-56 rounded-md bg-muted/50" aria-hidden="true" />
      </DetailPageBreadcrumbBar>
    );
  }

  return (
    <DetailPageBreadcrumbBar>
      <BreadcrumbLink
        pathname={ROUTES.agents}
        icon={<IconUsers size={14} stroke={1.5} className="shrink-0" />}
      >
        Agents
      </BreadcrumbLink>
      <span className="select-none text-muted-foreground/40">/</span>
      <BreadcrumbLink
        pathname={ROUTES.agentDetail}
        options={{ pathParams: { agentId: detail.agentId } }}
      >
        {agentLabel(detail)}
      </BreadcrumbLink>
      <span className="select-none text-muted-foreground/40">/</span>
      <BreadcrumbLink
        pathname={ROUTES.agentWorkflows}
        options={{ pathParams: { agentId: detail.agentId } }}
      >
        workflows
      </BreadcrumbLink>
      <span className="select-none text-muted-foreground/40">/</span>
      <span className="min-w-0 truncate rounded-md px-1.5 py-0.5 font-medium text-foreground">
        {workflowTitle(detail)}
      </span>
    </DetailPageBreadcrumbBar>
  );
}

function BreadcrumbLink({
  pathname,
  options,
  icon,
  children,
}: {
  readonly pathname: (typeof ROUTES)[keyof typeof ROUTES];
  readonly options?: Parameters<typeof Link>[0]["options"];
  readonly icon?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <Link
      pathname={pathname}
      options={options}
      className="inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-inherit no-underline transition-colors hover:bg-muted hover:text-foreground"
    >
      {icon}
      <span className="truncate">{children}</span>
    </Link>
  );
}

function DetailHeader({
  detail,
  activeTab,
  onTabChange,
}: {
  readonly detail: ZeroWorkflowDetailResponse | null;
  readonly activeTab: WorkflowDetailTab;
  readonly onTabChange: (tab: WorkflowDetailTab) => void;
}) {
  return (
    <DetailPageHeader>
      {detail ? (
        <>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h1 className="truncate text-lg font-semibold tracking-tight text-foreground sm:text-xl">
                {workflowTitle(detail)}
              </h1>
              <span className="inline-flex max-w-full shrink-0 items-center rounded-md border border-border/60 bg-muted/40 px-2 py-0.5 text-xs font-medium text-muted-foreground">
                /{detail.name}
              </span>
            </div>
            <p className="mt-1.5 line-clamp-2 text-sm leading-tight text-muted-foreground">
              {detail.description || "No description yet"}
            </p>
          </div>
          <div className="mt-4 flex items-center gap-2 sm:mt-6">
            <WorkflowTabNav activeTab={activeTab} onTabChange={onTabChange} />
            <WorkflowChatButton detail={detail} />
          </div>
        </>
      ) : (
        <div className="animate-pulse space-y-3">
          <div className="h-5 w-48 rounded bg-muted" />
          <div className="h-4 w-72 rounded bg-muted" />
          <div className="mt-4 h-9 w-80 rounded bg-muted" />
        </div>
      )}
    </DetailPageHeader>
  );
}

const WORKFLOW_TAB_TRIGGER_CLASS =
  "gap-1.5 px-3 text-sm data-[state=active]:bg-background";

function WorkflowTabNav({
  activeTab,
  onTabChange,
}: {
  readonly activeTab: WorkflowDetailTab;
  readonly onTabChange: (tab: WorkflowDetailTab) => void;
}) {
  return (
    <Tabs
      value={activeTab}
      onValueChange={(tab) => {
        onTabChange(tab as WorkflowDetailTab);
      }}
      className="min-w-0 flex-1"
    >
      <div className="sm:hidden">
        <Select
          value={activeTab}
          onValueChange={(tab) => {
            onTabChange(tab as WorkflowDetailTab);
          }}
        >
          <SelectTrigger className="h-9 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="authorization">Authorization</SelectItem>
            <SelectItem value="triggers">Triggers</SelectItem>
            <SelectItem value="instructions">Instructions</SelectItem>
            <SelectItem value="info">Info</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <TabsList className="zero-tabs hidden h-9 gap-1 px-1 py-1 sm:inline-flex">
        <TabsTrigger
          value="authorization"
          className={WORKFLOW_TAB_TRIGGER_CLASS}
        >
          <IconShieldLock size={14} stroke={1.5} />
          Authorization
        </TabsTrigger>
        <TabsTrigger value="triggers" className={WORKFLOW_TAB_TRIGGER_CLASS}>
          <IconClock size={14} stroke={1.5} />
          Triggers
        </TabsTrigger>
        <TabsTrigger
          value="instructions"
          className={WORKFLOW_TAB_TRIGGER_CLASS}
        >
          <IconFileText size={14} stroke={1.5} />
          Instructions
        </TabsTrigger>
        <TabsTrigger value="info" className={WORKFLOW_TAB_TRIGGER_CLASS}>
          <IconInfoCircle size={14} stroke={1.5} />
          Info
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

function WorkflowChatButton({
  detail,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
}) {
  const pageSignal = useGet(pageSignal$);
  const [openLoadable, openWorkflowChat] = useLoadableSet(openWorkflowChat$);
  const opening = openLoadable.state === "loading";
  const chatLabel = `Chat with ${agentLabel(detail)}`;

  return (
    <Button
      variant="outline"
      size="sm"
      type="button"
      aria-label={chatLabel}
      className="zero-btn-morandi shrink-0 gap-1.5"
      disabled={opening}
      onClick={() => {
        detach(
          openWorkflowChat(detail.id, pageSignal),
          Reason.DomCallback,
          "open workflow chat",
        );
      }}
    >
      {opening ? (
        <IconLoader2 size={14} className="animate-spin" />
      ) : (
        <IconMessageCircle size={14} stroke={2} />
      )}
      {chatLabel}
    </Button>
  );
}

function WorkflowTabContent({
  activeTab,
  detail,
}: {
  readonly activeTab: WorkflowDetailTab;
  readonly detail: ZeroWorkflowDetailResponse;
}) {
  const content = (() => {
    switch (activeTab) {
      case "authorization": {
        return <WorkflowAuthorizationTab detail={detail} />;
      }
      case "triggers": {
        return <TriggersSection detail={detail} />;
      }
      case "instructions": {
        return <WorkflowInstructionsTab detail={detail} />;
      }
      case "info": {
        return <WorkflowInfoTab detail={detail} />;
      }
    }
  })();

  return (
    <>
      <ShadowWarning detail={detail} />
      {content}
    </>
  );
}

function WorkflowAuthorizationTab({
  detail,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
}) {
  const authorizedLoadable = useLastLoadable(
    workflowAuthorizedConnectors(detail.id),
  );
  const authorizedConnectors =
    authorizedLoadable.state === "hasData" ? authorizedLoadable.data : [];
  const allTypesLoadable = useLastLoadable(allConnectorTypes$);
  const allConnectors =
    allTypesLoadable.state === "hasData" ? allTypesLoadable.data : [];
  const userGrantsLoadable = useLoadable(
    userPermissionGrantsByWorkflow({ workflowId: detail.id }),
  );
  const userGrants =
    userGrantsLoadable.state === "hasData" ? userGrantsLoadable.data : [];
  const userGrantPolicies =
    userGrantsLoadable.state === "hasData"
      ? permissionGrantsToFirewallPolicies(userGrants)
      : null;
  const drawerInitialPolicies: FirewallPolicies = userGrantPolicies ?? {};
  const [, applyGrantPolicies] = useLoadableSet(applyUserPermissionGrants$);
  const [saveConnectorsLoadable, setWorkflowConnectors] = useLoadableSet(
    setWorkflowAuthorizedConnectors$,
  );
  const pageSignal = useGet(pageSignal$);
  const connectorType = useGet(permConnectorType$);
  const setConnectorType = useSet(setPermConnectorType$);
  const routeSearchParams = useGet(searchParams$);
  const permissionDeepLink =
    workflowPermissionDeepLinkFromSearchParams(routeSearchParams);
  const replaceSearchParams = useSet(replaceSearchParams$);
  const search = useGet(permSearch$);
  const setSearch = useSet(setPermSearch$);
  const searchActive = useGet(permSearchActive$);
  const setSearchActive = useSet(setPermSearchActive$);
  const savingType = useGet(permSavingType$);
  const setSavingType = useSet(setPermSavingType$);
  const connectedConnectors = allConnectors.filter((connector) => {
    return connector.connected;
  });
  const filteredConnectors = connectedConnectors.filter((connector) => {
    return matchesConnectorSearch(search, connector);
  });
  const deepLinkedConnectorType =
    permissionDeepLink !== null
      ? (connectedConnectors.find((connector) => {
          return connector.type === permissionDeepLink.connectorRef;
        })?.type ?? null)
      : null;
  const selectedConnectorType = connectorType ?? deepLinkedConnectorType;
  const authorizedSet = new Set(authorizedConnectors);
  const loading =
    authorizedLoadable.state === "loading" ||
    allTypesLoadable.state !== "hasData" ||
    userGrantsLoadable.state === "loading";

  const handleToggle = async (type: ConnectorType, checked: boolean) => {
    if (savingType !== null || saveConnectorsLoadable.state === "loading") {
      return;
    }
    const next = checked
      ? Array.from(new Set([...authorizedConnectors, type]))
      : authorizedConnectors.filter((connector) => {
          return connector !== type;
        });
    setSavingType(type);
    await bestEffort(
      (async () => {
        await setWorkflowConnectors(
          { workflowId: detail.id, enabledTypes: next },
          pageSignal,
        );
        toast.success("Connectors saved");
      })(),
    );
    setSavingType(null);
  };

  if (loading) {
    return <PermissionListSkeleton />;
  }

  if (userGrantsLoadable.state === "hasError") {
    return <PermissionGrantsError />;
  }

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-4">
      {connectedConnectors.length === 0 ? (
        <NoConnectedConnectors />
      ) : (
        <>
          <ConnectedConnectorPermissions
            filteredConnectors={filteredConnectors}
            authorizedSet={authorizedSet}
            search={search}
            setSearch={setSearch}
            searchActive={searchActive}
            setSearchActive={setSearchActive}
            savingType={savingType}
            canManagePermissions
            onToggle={handleToggle}
            onManage={setConnectorType}
          />
          <WorkflowAuthorizationPermissionDrawer
            detail={detail}
            connectorType={selectedConnectorType}
            deepLinkedConnectorType={deepLinkedConnectorType}
            permissionDeepLink={permissionDeepLink}
            routeSearchParams={routeSearchParams}
            initialPolicies={drawerInitialPolicies}
            initialGrants={userGrants}
            pageSignal={pageSignal}
            applyGrantPolicies={applyGrantPolicies}
            onSelectConnector={setConnectorType}
            onReplaceSearchParams={replaceSearchParams}
          />
        </>
      )}
    </div>
  );
}

function WorkflowAuthorizationPermissionDrawer({
  detail,
  connectorType,
  deepLinkedConnectorType,
  permissionDeepLink,
  routeSearchParams,
  initialPolicies,
  initialGrants,
  pageSignal,
  applyGrantPolicies,
  onSelectConnector,
  onReplaceSearchParams,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
  readonly connectorType: ConnectorType | null;
  readonly deepLinkedConnectorType: ConnectorType | null;
  readonly permissionDeepLink: WorkflowPermissionDeepLink | null;
  readonly routeSearchParams: URLSearchParams;
  readonly initialPolicies: FirewallPolicies;
  readonly initialGrants: Parameters<
    typeof savePermissionDraftPolicies
  >[0]["initialGrants"];
  readonly pageSignal: AbortSignal;
  readonly applyGrantPolicies: ApplyUserPermissionGrants;
  readonly onSelectConnector: (type: ConnectorType | null) => void;
  readonly onReplaceSearchParams: (params: URLSearchParams) => void;
}) {
  const fromPermissionDeepLink = connectorType === deepLinkedConnectorType;

  return (
    <AgentPermissionsDrawer
      targetId={detail.id}
      targetKind="workflow"
      connectorType={connectorType}
      displayName={workflowTitle(detail)}
      initialPolicies={initialPolicies}
      initialGrants={initialGrants}
      initialIntent={
        fromPermissionDeepLink ? permissionDeepLink?.initialIntent : undefined
      }
      initialSearch={
        fromPermissionDeepLink ? permissionDeepLink?.initialSearch : undefined
      }
      initialContextKey={
        fromPermissionDeepLink
          ? permissionDeepLink?.initialContextKey
          : undefined
      }
      resetEnabled
      readOnly={false}
      onApply={async (intent, { metadata }) => {
        if (connectorType === null) {
          throw new Error("Cannot save permissions without a connector");
        }
        await savePermissionDraftPolicies({
          scope: { workflowId: detail.id },
          connectorType,
          metadata,
          initialPolicies,
          initialGrants,
          intent,
          pageSignal,
          applyGrantPolicies,
        });
        toast.success("Permissions updated");
      }}
      onClose={() => {
        onSelectConnector(null);
        if (permissionDeepLink) {
          onReplaceSearchParams(
            workflowSearchParamsWithoutPermissionDeepLink(routeSearchParams),
          );
        }
      }}
    />
  );
}

function WorkflowInfoTab({
  detail,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
}) {
  const actionDialog = useGet(workflowActionDialog$);
  const setActionDialog = useSet(setWorkflowActionDialog$);

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-4">
      <WorkflowMetadataForm detail={detail} />
      <div className="zero-card overflow-hidden">
        <div className="p-4 sm:p-5">
          <InlineSettingsRow
            label="Copy workflow"
            description="Copy this workflow to another agent."
            alignControls="center"
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="zero-btn-morandi h-9 gap-2 rounded-lg"
              onClick={() => {
                setActionDialog("copy");
              }}
            >
              <IconCopy size={14} stroke={1.5} />
              Copy workflow
            </Button>
          </InlineSettingsRow>
        </div>
      </div>
      {detail.canManage ? (
        <div className="zero-card overflow-hidden border-destructive/20">
          <div className="p-4 sm:p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
              <div className="min-w-0 sm:max-w-[46%]">
                <h3 className="text-sm font-medium text-foreground">
                  Danger zone
                </h3>
                <p className="mt-1 text-xs leading-snug text-muted-foreground">
                  Delete this workflow and its triggers. This action cannot be
                  undone.
                </p>
              </div>
              <div className="flex w-full shrink-0 justify-end sm:w-auto">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 gap-2 rounded-lg border-destructive/40 px-4 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => {
                    setActionDialog("delete");
                  }}
                >
                  <IconTrash size={14} stroke={1.5} />
                  Delete workflow
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      <div className="zero-card px-5 py-4">
        <WorkflowAuditMetadata detail={detail} />
      </div>
      <WorkflowCopyDialog
        detail={detail}
        open={actionDialog === "copy"}
        onOpenChange={(open) => {
          setActionDialog(open ? "copy" : null);
        }}
      />
      <WorkflowDeleteDialog
        detail={detail}
        open={actionDialog === "delete"}
        onOpenChange={(open) => {
          setActionDialog(open ? "delete" : null);
        }}
      />
    </div>
  );
}

interface WorkflowMetadataValues {
  readonly displayName: string;
  readonly name: string;
  readonly description: string;
}

function workflowMetadataDefaults(
  detail: ZeroWorkflowDetailResponse,
): WorkflowMetadataValues {
  return {
    displayName: detail.displayName ?? "",
    name: detail.name,
    description: detail.description ?? "",
  };
}

function isValidWorkflowSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(value);
}

function WorkflowMetadataFields({
  detail,
  disabled,
  onPatch,
  values,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
  readonly disabled: boolean;
  readonly onPatch: (patch: Partial<WorkflowMetadataValues>) => void;
  readonly values: WorkflowMetadataValues;
}) {
  const slugCommand = `/${values.name.trim() || "slug"}`;

  return (
    <div className="p-4 sm:p-5">
      <InlineSettingsRow
        label="Name"
        description="Shown in workflow lists and when choosing a workflow."
        wideControls
      >
        <Input
          id="workflow-edit-display-name"
          name="displayName"
          aria-label="Name"
          value={values.displayName}
          onChange={(event) => {
            onPatch({ displayName: event.currentTarget.value });
          }}
          disabled={disabled}
          placeholder="Workflow name"
          maxLength={256}
          className="h-9 w-full"
        />
      </InlineSettingsRow>
      <InlineSettingsRow
        label="Slug"
        description={`Lowercase letters, numbers, and - only. Use ${slugCommand} in chat to use this workflow.`}
        wideControls
      >
        <Input
          id="workflow-edit-slug"
          name="name"
          aria-label="Slug"
          value={values.name}
          onChange={(event) => {
            onPatch({ name: event.currentTarget.value });
          }}
          disabled={disabled}
          placeholder="workflow-slug"
          maxLength={64}
          required
          minLength={2}
          pattern="[a-z0-9][a-z0-9-]*[a-z0-9]"
          title="Use lowercase letters, numbers, and hyphens only"
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          className="h-9 w-full"
        />
      </InlineSettingsRow>
      <InlineSettingsRow
        label="Description"
        description="Tell the agent when to use this workflow."
        wideControls
      >
        <textarea
          id="workflow-edit-description"
          name="description"
          aria-label="Description"
          value={values.description}
          onChange={(event) => {
            onPatch({ description: event.currentTarget.value });
          }}
          disabled={disabled}
          rows={3}
          maxLength={1024}
          className={WORKFLOW_EDIT_TEXTAREA_CLASS}
        />
      </InlineSettingsRow>
      <InlineSettingsRow
        label="Visibility"
        description="Choose how this workflow is shared inside your workspace."
        alignControls="center"
      >
        <div className="w-full max-w-72">
          <WorkflowPublicToggle detail={detail} />
        </div>
      </InlineSettingsRow>
    </div>
  );
}

function WorkflowMetadataForm({
  detail,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
}) {
  const pageSignal = useGet(pageSignal$);
  const patch = useGet(workflowMetadataPatch$);
  const patchForm = useSet(patchWorkflowMetadataForm$);
  const resetForm = useSet(resetWorkflowMetadataForm$);
  const [saveLoadable, updateWorkflow] = useLoadableSet(updateWorkflow$);
  const saving = saveLoadable.state === "loading";
  const disabled = !detail.canManage || saving;
  const defaults = workflowMetadataDefaults(detail);
  const values =
    patch?.workflowId === detail.id ? { ...defaults, ...patch } : defaults;
  const dirty =
    values.displayName !== defaults.displayName ||
    values.name !== defaults.name ||
    values.description !== defaults.description;
  const patchValues = (patch: Partial<WorkflowMetadataValues>) => {
    patchForm({ workflowId: detail.id, patch });
  };
  const save = () => {
    if (!detail.canManage) {
      return;
    }
    const nextDisplayName = values.displayName.trim();
    const nextName = values.name.trim();
    const nextDescription = values.description.trim();
    if (!isValidWorkflowSlug(nextName)) {
      return;
    }
    detach(
      (async () => {
        await updateWorkflow(
          {
            workflowId: detail.id,
            body: {
              name: nextName,
              displayName: nextDisplayName || null,
              description: nextDescription || null,
            },
          },
          pageSignal,
        );
        toast.success("Workflow saved");
      })(),
      Reason.DomCallback,
    );
  };

  return (
    <>
      <form
        aria-label="Workflow metadata"
        className="zero-card overflow-hidden"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          if (!event.currentTarget.checkValidity()) {
            return;
          }
          save();
        }}
      >
        <WorkflowMetadataFields
          detail={detail}
          disabled={disabled}
          onPatch={patchValues}
          values={values}
        />
      </form>
      {dirty ? (
        <ZeroUnsavedBar onDiscard={resetForm} onSave={save} saving={saving} />
      ) : null}
    </>
  );
}

function WorkflowInstructionsTab({
  detail,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
}) {
  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-3">
      <div className="flex min-w-0 items-center">
        <WorkflowFilePicker detail={detail} />
      </div>
      <div className="zero-card overflow-hidden px-5 pb-5">
        <WorkflowFilePreview detail={detail} />
      </div>
    </div>
  );
}

function ShadowWarning({
  detail,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
}) {
  if (!detail.shadowedBy) {
    return null;
  }

  return (
    <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
      <IconAlertTriangle size={16} stroke={1.5} className="mt-0.5 shrink-0" />
      <p className="min-w-0">
        <span className="font-medium">/{detail.name}</span> currently resolves
        to{" "}
        <span className="font-medium">{workflowTitle(detail.shadowedBy)}</span>{" "}
        for you. This workflow is shadowed by the same-slug priority rule.
      </p>
    </div>
  );
}

function WorkflowAuditMetadata({
  detail,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
}) {
  const membersLoadable = useLoadable(orgMembers$);
  const members =
    membersLoadable.state === "hasData" ? membersLoadable.data : [];
  const membersById = new Map(
    members.map((member) => {
      return [member.userId, member];
    }),
  );

  return (
    <div className="px-3 py-2 text-xs leading-5 text-muted-foreground">
      <div>
        <p>
          Created by {workflowUserLabel(detail.createdByUserId, membersById)}
        </p>
        <p>{formatWorkflowAuditDate(detail.createdAt)}</p>
      </div>
      <div className="mt-2">
        <p>
          Last updated by{" "}
          {workflowUserLabel(detail.updatedByUserId, membersById)}
        </p>
        <p>{formatWorkflowAuditDate(detail.updatedAt)}</p>
      </div>
    </div>
  );
}

function workflowUserLabel(
  userId: string,
  membersById: ReadonlyMap<string, OrgMember>,
): string {
  const member = membersById.get(userId);
  return member ? orgMemberDisplayName(member) : userId;
}

function orgMemberDisplayName(member: OrgMember): string {
  const fullName = [member.firstName, member.lastName]
    .filter((part): part is string => {
      return Boolean(part);
    })
    .join(" ");
  return fullName || member.email || member.userId;
}

function formatWorkflowAuditDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function WorkflowPublicToggle({
  detail,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
}) {
  const pageSignal = useGet(pageSignal$);
  const [changeLoadable, changeVisibility] = useLoadableSet(
    changeWorkflowVisibility$,
  );
  const busy = changeLoadable.state === "loading";
  const requested = detail.visibility === "private" && detail.requestToPublish;
  const isPublic = detail.visibility === "public";
  const checked = requested || isPublic;
  const statusLabel = isPublic
    ? "Public"
    : requested
      ? "Requested to public"
      : "Private";
  const toggleAction: Parameters<typeof changeVisibility>[0]["action"] | null =
    isPublic
      ? detail.canManage
        ? "demote"
        : null
      : requested
        ? "cancel-publish-request"
        : "request-publish";
  const submitVisibilityAction = (
    action: Parameters<typeof changeVisibility>[0]["action"],
  ) => {
    detach(
      changeVisibility({ workflowId: detail.id, action }, pageSignal),
      Reason.DomCallback,
    );
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-end gap-3">
        <span className="text-xs text-muted-foreground">{statusLabel}</span>
        <button
          type="button"
          role="switch"
          aria-label="Make workflow public"
          aria-checked={checked}
          disabled={busy || !toggleAction}
          className={cn(
            "relative h-5 w-9 shrink-0 rounded-full transition-colors",
            isPublic ? "bg-primary/70" : "bg-muted",
            busy || !toggleAction ? "cursor-not-allowed opacity-60" : "",
          )}
          onClick={() => {
            if (toggleAction) {
              submitVisibilityAction(toggleAction);
            }
          }}
        >
          <span
            className={cn(
              "absolute left-0.5 top-0.5 size-4 rounded-full bg-background shadow-sm transition-transform",
              checked ? "translate-x-4" : "translate-x-0",
            )}
          />
        </button>
      </div>
      {requested ? (
        <p className="text-xs leading-5 text-muted-foreground">
          This workflow is waiting for the agent owner to review before it can
          go public.
        </p>
      ) : null}
      {requested && detail.canManage ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            className="zero-btn-morandi inline-flex h-8 items-center rounded-md px-2 text-xs"
            onClick={() => {
              submitVisibilityAction("approve-publish");
            }}
          >
            Approve
          </button>
          <button
            type="button"
            disabled={busy}
            className="zero-btn-morandi inline-flex h-8 items-center rounded-md px-2 text-xs text-destructive/90"
            onClick={() => {
              submitVisibilityAction("reject-publish");
            }}
          >
            Reject
          </button>
        </div>
      ) : null}
    </div>
  );
}

function WorkflowCopyDialog({
  detail,
  open,
  onOpenChange,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const agentsLoadable = useLoadable(agents$);
  const agents =
    agentsLoadable.state === "hasData"
      ? agentsLoadable.data.filter((agent) => {
          return agent.id !== detail.agentId;
        })
      : [];
  const pageSignal = useGet(pageSignal$);
  const [copyLoadable, copyWorkflow] = useLoadableSet(copyWorkflow$);
  const copying = copyLoadable.state === "loading";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Copy workflow</DialogTitle>
          <DialogDescription>
            Copy to another agent as a new private workflow.
          </DialogDescription>
        </DialogHeader>
        {agents.length > 0 ? (
          <div className="max-h-[360px] overflow-auto rounded-md border border-border/60">
            {agents.map((agent) => {
              return (
                <button
                  key={agent.id}
                  type="button"
                  disabled={copying}
                  className="flex w-full items-center justify-between gap-3 border-b border-border/60 px-3 py-2 text-left last:border-b-0 transition-colors hover:bg-muted disabled:opacity-60"
                  onClick={() => {
                    detach(
                      (async () => {
                        await copyWorkflow(
                          {
                            workflowId: detail.id,
                            toAgentId: agent.id,
                          },
                          pageSignal,
                        );
                        onOpenChange(false);
                      })(),
                      Reason.DomCallback,
                    );
                  }}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {agent.displayName ?? agent.id}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {agent.visibility === "private"
                        ? "Private agent"
                        : "Public agent"}
                    </span>
                  </span>
                  {copying ? (
                    <IconLoader2
                      size={14}
                      className="shrink-0 animate-spin text-muted-foreground"
                    />
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : agentsLoadable.state === "hasData" ? (
          <p className="text-sm text-muted-foreground">
            No other agents are available.
          </p>
        ) : (
          <div className="h-24 rounded-md bg-muted/50" aria-hidden="true" />
        )}
      </DialogContent>
    </Dialog>
  );
}

function WorkflowDeleteDialog({
  detail,
  open,
  onOpenChange,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const navigate = useSet(detachedNavigateTo$);
  const [deleteLoadable, deleteWorkflow] = useLoadableSet(deleteWorkflow$);
  const deleting = deleteLoadable.state === "loading";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete workflow</DialogTitle>
          <DialogDescription>
            This is a dangerous operation. Deleting this workflow also deletes
            every trigger bound to it, including triggers other users created.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {workflowTitle(detail)} and all bound triggers will be deleted.
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={deleting}
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={deleting}
            onClick={() => {
              detach(
                (async () => {
                  await deleteWorkflow(detail.id, pageSignal);
                  onOpenChange(false);
                  navigate(ROUTES.agentWorkflows, {
                    pathParams: { agentId: detail.agentId },
                  });
                })(),
                Reason.DomCallback,
              );
            }}
          >
            {deleting ? (
              <IconLoader2 size={14} className="animate-spin" />
            ) : null}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WorkflowFilePicker({
  detail,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
}) {
  const selectedFilePath = useGet(selectedWorkflowFilePath$);
  const setSelectedFilePath = useSet(setSelectedWorkflowFilePath$);
  const files: readonly WorkflowFileMetadata[] = detail.files ?? [];
  const fileContents: readonly WorkflowFileEntry[] = detail.fileContents ?? [];
  const pageSignal = useGet(pageSignal$);
  const [saveLoadable, updateWorkflow] = useLoadableSet(updateWorkflow$);
  const saving = saveLoadable.state === "loading";
  const selectedLabel = selectedFilePath ?? "instructions";
  const uploadFiles = (selected: FileList) => {
    detach(
      (async () => {
        const uploaded = await readUploadedWorkflowFiles(selected);
        const byPath = new Map(
          fileContents.map((file) => {
            return [file.path, file];
          }),
        );
        for (const file of uploaded) {
          byPath.set(file.path, file);
        }
        await updateWorkflow(
          {
            workflowId: detail.id,
            body: { files: [...byPath.values()] },
          },
          pageSignal,
        );
        setSelectedFilePath(uploaded[0]?.path ?? null);
      })(),
      Reason.DomCallback,
    );
  };
  const deleteSelectedFile = () => {
    if (!selectedFilePath) {
      return;
    }
    detach(
      (async () => {
        const nextFiles = fileContents.filter((file) => {
          return file.path !== selectedFilePath;
        });
        await updateWorkflow(
          {
            workflowId: detail.id,
            body: { files: nextFiles },
          },
          pageSignal,
        );
        setSelectedFilePath(null);
      })(),
      Reason.DomCallback,
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Workflow files"
          className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-sm px-0.5 py-0.5 text-sm font-medium text-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="min-w-0 truncate">{selectedLabel}</span>
          <IconChevronDown
            size={14}
            stroke={1.5}
            className="shrink-0 text-muted-foreground"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <WorkflowFileNavigationItems
          files={files}
          selectedFilePath={selectedFilePath}
          onSelectFile={setSelectedFilePath}
        />
        {detail.canManage ? (
          <WorkflowFileManagementItems
            saving={saving}
            selectedFilePath={selectedFilePath}
            onUpload={uploadFiles}
            onDeleteSelectedFile={deleteSelectedFile}
          />
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WorkflowFileNavigationItems({
  files,
  selectedFilePath,
  onSelectFile,
}: {
  readonly files: readonly WorkflowFileMetadata[];
  readonly selectedFilePath: string | null;
  readonly onSelectFile: (filePath: string | null) => void;
}) {
  return (
    <>
      <DropdownMenuItem
        className={cn(!selectedFilePath ? "bg-muted" : "")}
        onSelect={() => {
          onSelectFile(null);
        }}
      >
        instructions
      </DropdownMenuItem>
      {files.map((file) => {
        return (
          <DropdownMenuItem
            key={file.path}
            className={cn(selectedFilePath === file.path ? "bg-muted" : "")}
            onSelect={() => {
              onSelectFile(file.path);
            }}
          >
            <span className="min-w-0 truncate">{file.path}</span>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
              {file.size} B
            </span>
          </DropdownMenuItem>
        );
      })}
    </>
  );
}

function WorkflowFileManagementItems({
  saving,
  selectedFilePath,
  onUpload,
  onDeleteSelectedFile,
}: {
  readonly saving: boolean;
  readonly selectedFilePath: string | null;
  readonly onUpload: (files: FileList) => void;
  readonly onDeleteSelectedFile: () => void;
}) {
  return (
    <>
      <div className="my-1 h-px bg-border/60" />
      <label
        className={cn(
          "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground",
          saving ? "pointer-events-none opacity-60" : "",
        )}
      >
        {saving ? (
          <IconLoader2 size={15} className="animate-spin" />
        ) : (
          <IconUpload size={15} stroke={1.5} />
        )}
        <span>Upload text files</span>
        <input
          aria-label="Upload workflow files"
          type="file"
          multiple
          disabled={saving}
          className="sr-only"
          onChange={(event) => {
            const selected = event.currentTarget.files;
            if (!selected || selected.length === 0) {
              return;
            }
            onUpload(selected);
            event.currentTarget.value = "";
          }}
        />
      </label>
      {selectedFilePath ? (
        <button
          type="button"
          aria-label={`Delete ${selectedFilePath}`}
          disabled={saving}
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-destructive transition-colors hover:bg-accent disabled:opacity-60"
          onClick={onDeleteSelectedFile}
        >
          <IconTrash size={15} stroke={1.5} />
          <span>Delete selected file</span>
        </button>
      ) : null}
    </>
  );
}

function workflowDraftUpdateBody(
  selectedFilePath: string | null,
  draft: string,
  fileContents: readonly WorkflowFileEntry[],
): ZeroWorkflowUpdateRequest {
  if (!selectedFilePath) {
    return { instruction: draft || null };
  }

  return {
    files: fileContents.map((file) => {
      return file.path === selectedFilePath
        ? { path: file.path, content: draft }
        : file;
    }),
  };
}

function selectedWorkflowFile(
  fileContents: readonly WorkflowFileEntry[],
  selectedFilePath: string | null,
): WorkflowFileEntry | null {
  if (!selectedFilePath) {
    return null;
  }

  return (
    fileContents.find((file) => {
      return file.path === selectedFilePath;
    }) ?? null
  );
}

function workflowSelectedSourceContent(
  detail: ZeroWorkflowDetailResponse,
  selectedFilePath: string | null,
  selectedFile: WorkflowFileEntry | null,
): string {
  if (!selectedFilePath) {
    return detail.instruction ?? "";
  }

  return selectedFile?.content ?? "";
}

function WorkflowFilePreview({
  detail,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
}) {
  const selectedFilePath = useGet(selectedWorkflowFilePath$);
  const fileContents: readonly WorkflowFileEntry[] = detail.fileContents ?? [];
  const selectedFile = selectedWorkflowFile(fileContents, selectedFilePath);
  const sourceContent = workflowSelectedSourceContent(
    detail,
    selectedFilePath,
    selectedFile,
  );

  if (selectedFilePath && !selectedFile) {
    return (
      <div className="flex min-h-[360px] items-center justify-center text-sm text-muted-foreground">
        No content available for this file.
      </div>
    );
  }

  return (
    <WorkflowSelectedFileEditor
      detail={detail}
      fileContents={fileContents}
      selectedFilePath={selectedFilePath}
      sourceContent={sourceContent}
    />
  );
}

function WorkflowSelectedFileEditor({
  detail,
  fileContents,
  selectedFilePath,
  sourceContent,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
  readonly fileContents: readonly WorkflowFileEntry[];
  readonly selectedFilePath: string | null;
  readonly sourceContent: string;
}) {
  const draftState = useGet(workflowFileDraft$);
  const setDraftState = useSet(setWorkflowFileDraft$);
  const pageSignal = useGet(pageSignal$);
  const [saveLoadable, updateWorkflow] = useLoadableSet(updateWorkflow$);
  const saving = saveLoadable.state === "loading";
  const draftMatches =
    draftState?.workflowId === detail.id &&
    draftState.filePath === selectedFilePath &&
    draftState.sourceContent === sourceContent;
  const draft = draftMatches ? draftState.content : null;
  const content = draft ?? sourceContent;
  const dirty = draft !== null && draft !== sourceContent;
  const markdown =
    selectedFilePath === null || isMarkdownPath(selectedFilePath);
  const setDraft = (nextContent: string) => {
    setDraftState({
      workflowId: detail.id,
      filePath: selectedFilePath,
      sourceContent,
      content: nextContent,
    });
  };

  const saveDraft = () => {
    if (!detail.canManage || draft === null) {
      return;
    }
    const body = workflowDraftUpdateBody(selectedFilePath, draft, fileContents);
    detach(
      (async () => {
        await updateWorkflow(
          {
            workflowId: detail.id,
            body,
          },
          pageSignal,
        );
        setDraftState(null);
      })(),
      Reason.DomCallback,
    );
  };

  return (
    <div className="flex flex-1 flex-col">
      {markdown ? (
        <TiptapInstructionsEditor
          key={`${detail.id}:${selectedFilePath ?? "instructions"}:${sourceContent}`}
          initialContent={content}
          onChange={setDraft}
          disabled={!detail.canManage || saving}
          footerHint={null}
          surface="canvas"
          ariaLabel={
            selectedFilePath ? "Workflow file content" : "Workflow instruction"
          }
          placeholder={
            selectedFilePath
              ? "Edit this markdown file..."
              : "Write workflow instructions..."
          }
        />
      ) : (
        <textarea
          aria-label="Workflow file content"
          value={content}
          disabled={!detail.canManage || saving}
          spellCheck={false}
          className="min-h-[calc(100vh-10rem)] w-full resize-none bg-transparent px-0 py-3 font-mono text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60"
          onChange={(event) => {
            setDraft(event.currentTarget.value);
          }}
        />
      )}
      {dirty ? (
        <ZeroUnsavedBar
          saving={saving}
          onDiscard={() => {
            setDraftState(null);
          }}
          onSave={saveDraft}
        />
      ) : null}
    </div>
  );
}

async function readUploadedWorkflowFiles(
  files: FileList,
): Promise<WorkflowFileEntry[]> {
  return await Promise.all(
    Array.from(files).map(async (file) => {
      const uploadFile = file as File & {
        readonly webkitRelativePath?: string;
      };
      const path = (uploadFile.webkitRelativePath || file.name).replace(
        /^\.\//,
        "",
      );
      return { path, content: await file.text() };
    }),
  );
}

function browserTimezone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function timezoneDisplayName(timezone: string): string {
  return timezone.replace(/_/g, " ");
}

function formatClockTime(hour: number, minute: number): string {
  const ampm = hour >= 12 ? "PM" : "AM";
  const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${h12}:${String(minute).padStart(2, "0")} ${ampm}`;
}

function getWorkflowMinuteOptions(currentMinute: number): readonly number[] {
  if (WORKFLOW_CRON_MINUTE_OPTIONS.includes(currentMinute)) {
    return WORKFLOW_CRON_MINUTE_OPTIONS;
  }
  return [...WORKFLOW_CRON_MINUTE_OPTIONS, currentMinute].sort((a, b) => {
    return a - b;
  });
}

function parseCronNumber(
  value: string | undefined,
  min: number,
  max: number,
): number | null {
  if (!value || !/^\d+$/u.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : null;
}

function normalizeCronDayOfWeek(day: number): number {
  return day === 7 ? 0 : day;
}

function parseCronDayOfWeekList(value: string): readonly number[] | null {
  const days: number[] = [];
  for (const part of value.split(",")) {
    const [startRaw, endRaw] = part.split("-");
    const start = parseCronNumber(startRaw, 0, 7);
    const end = parseCronNumber(endRaw ?? startRaw, 0, 7);
    if (start === null || end === null) {
      return null;
    }
    const normalizedStart = normalizeCronDayOfWeek(start);
    const normalizedEnd = normalizeCronDayOfWeek(end);
    if (normalizedStart <= normalizedEnd) {
      for (let day = normalizedStart; day <= normalizedEnd; day += 1) {
        days.push(day);
      }
    } else {
      for (let day = normalizedStart; day <= 6; day += 1) {
        days.push(day);
      }
      for (let day = 0; day <= normalizedEnd; day += 1) {
        days.push(day);
      }
    }
  }
  const unique = [...new Set(days)];
  return unique.length > 0
    ? unique.sort((a, b) => {
        return a - b;
      })
    : null;
}

function shiftCronDays(
  days: readonly number[],
  dayOffset: number,
): readonly number[] {
  return [
    ...new Set(
      days.map((day) => {
        return (day + dayOffset + 7) % 7;
      }),
    ),
  ].sort((a, b) => {
    return a - b;
  });
}

function formatCronDayOfWeekList(days: readonly number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => {
    return a - b;
  });
  const weekdays = [1, 2, 3, 4, 5];
  if (
    sorted.length === weekdays.length &&
    sorted.every((day, index) => {
      return day === weekdays[index];
    })
  ) {
    return "1-5";
  }
  return sorted.join(",");
}

function sameNumberList(a: readonly number[], b: readonly number[]): boolean {
  return (
    a.length === b.length &&
    a.every((value, index) => {
      return value === b[index];
    })
  );
}

function shiftedDayOfMonth(
  dayOfMonth: string,
  dayOffset: number,
): string | null {
  const day = parseCronNumber(dayOfMonth, 1, 31);
  if (day === null) {
    return null;
  }
  const shifted = day + dayOffset;
  return shifted >= 1 && shifted <= 31 ? String(shifted) : String(day);
}

function parseWorkflowCronFields(
  schedule: Extract<ZeroWorkflowSchedule, { type: "cron" }>,
  displayTimezone: string,
): WorkflowCronFields {
  const parts = schedule.cronExpression.trim().split(/\s+/u);
  const minute = parseCronNumber(parts[0], 0, 59);
  const hour = parseCronNumber(parts[1], 0, 23);
  const dayOfMonth = parts[2] ?? "*";
  const dayOfWeek = parts[4] ?? "*";
  if (parts.length !== 5 || minute === null || hour === null) {
    return {
      ...defaultWorkflowCronFields(),
      frequency: "custom",
      customCronExpression: schedule.cronExpression,
    };
  }

  const converted = cronWallTimeInTimezone(
    hour,
    minute,
    schedule.timezone || TRIGGER_TIMEZONE,
    displayTimezone,
  );
  const base = {
    ...defaultWorkflowCronFields(),
    hour: converted.hour,
    minute: converted.minute,
    customCronExpression: schedule.cronExpression,
  };

  if (dayOfMonth === "*" && dayOfWeek === "*") {
    return { ...base, frequency: "every_day" };
  }

  if (dayOfMonth !== "*" && dayOfWeek === "*") {
    const displayDayOfMonth = shiftedDayOfMonth(
      dayOfMonth,
      converted.dayOffset,
    );
    return displayDayOfMonth
      ? { ...base, frequency: "every_month", dayOfMonth: displayDayOfMonth }
      : { ...base, frequency: "custom" };
  }

  if (dayOfMonth === "*" && dayOfWeek !== "*") {
    const utcDays = parseCronDayOfWeekList(dayOfWeek);
    if (!utcDays) {
      return { ...base, frequency: "custom" };
    }
    const displayDays = shiftCronDays(utcDays, converted.dayOffset);
    if (sameNumberList(displayDays, [1, 2, 3, 4, 5])) {
      return {
        ...base,
        frequency: "every_weekday",
        dayOfWeek: "1,2,3,4,5",
      };
    }
    return {
      ...base,
      frequency: "every_week",
      dayOfWeek: formatCronDayOfWeekList(displayDays),
    };
  }

  return { ...base, frequency: "custom" };
}

function buildUtcCronExpressionFromFields(
  fields: WorkflowCronFields,
  displayTimezone: string,
): string | null {
  if (fields.frequency === "custom") {
    const cronExpression = fields.customCronExpression.trim();
    return cronExpression.length > 0 ? cronExpression : null;
  }

  const converted = cronWallTimeInTimezone(
    fields.hour,
    fields.minute,
    displayTimezone,
    TRIGGER_TIMEZONE,
  );
  const minute = String(converted.minute);
  const hour = String(converted.hour);

  if (fields.frequency === "every_weekday") {
    const days = shiftCronDays([1, 2, 3, 4, 5], converted.dayOffset);
    return `${minute} ${hour} * * ${formatCronDayOfWeekList(days)}`;
  }
  if (fields.frequency === "every_week") {
    const displayDays = parseCronDayOfWeekList(fields.dayOfWeek);
    if (!displayDays) {
      return null;
    }
    const days = shiftCronDays(displayDays, converted.dayOffset);
    return `${minute} ${hour} * * ${formatCronDayOfWeekList(days)}`;
  }
  if (fields.frequency === "every_month") {
    const dayOfMonth = shiftedDayOfMonth(
      fields.dayOfMonth,
      converted.dayOffset,
    );
    return dayOfMonth ? `${minute} ${hour} ${dayOfMonth} * *` : null;
  }

  return buildCronExpression({
    timeOption: WORKFLOW_CRON_FREQUENCY_TO_TIME_OPTION[fields.frequency],
    hour,
    minute,
  });
}

function workflowScheduleTitle(
  trigger: ZeroWorkflowTriggerSummary,
  displayTimezone: string,
): string {
  if (trigger.kind !== "schedule") {
    return workflowTriggerTitle(trigger);
  }
  const schedule = trigger.schedule;
  if (schedule.type === "loop") {
    return `Every ${formatWorkflowIntervalSeconds(schedule.intervalSeconds)}`;
  }
  if (schedule.type === "once") {
    const { date, hour, minute } = atTimeInTimezone(
      schedule.atTime,
      displayTimezone,
    );
    return `Once on ${date} at ${formatClockTime(hour, minute)}`;
  }

  const fields = parseWorkflowCronFields(schedule, displayTimezone);
  if (fields.frequency === "custom") {
    return `${schedule.cronExpression} (${TRIGGER_TIMEZONE})`;
  }
  const time = formatClockTime(fields.hour, fields.minute);
  if (fields.frequency === "every_day") {
    return `Every day at ${time}`;
  }
  if (fields.frequency === "every_weekday") {
    return `Every weekday at ${time}`;
  }
  if (fields.frequency === "every_month") {
    return `Every month on day ${fields.dayOfMonth} at ${time}`;
  }
  const dayLabels = fields.dayOfWeek
    .split(",")
    .map((day) => {
      return WORKFLOW_DAY_OF_WEEK_OPTIONS.find(([value]) => {
        return value === day;
      })?.[1];
    })
    .filter(Boolean)
    .join(", ");
  return dayLabels
    ? `Every week on ${dayLabels} at ${time}`
    : trigger.scheduleSummary;
}

function buildTriggerSchedule(
  type: ZeroWorkflowScheduleType,
  fields: {
    readonly cronFields: WorkflowCronFields;
    readonly intervalSeconds: string;
    readonly atTime: string;
  },
  displayTimezone: string,
): ZeroWorkflowSchedule | null {
  if (type === "cron") {
    const cronExpression = buildUtcCronExpressionFromFields(
      fields.cronFields,
      displayTimezone,
    );
    return cronExpression
      ? { type: "cron", cronExpression, timezone: TRIGGER_TIMEZONE }
      : null;
  }
  if (type === "loop") {
    const intervalSeconds = Number(fields.intervalSeconds);
    return Number.isInteger(intervalSeconds) && intervalSeconds > 0
      ? { type: "loop", intervalSeconds }
      : null;
  }
  if (!fields.atTime) {
    return null;
  }
  const atTime = new Date(fields.atTime);
  return Number.isNaN(atTime.getTime())
    ? null
    : {
        type: "once",
        atTime: atTime.toISOString(),
        timezone: TRIGGER_TIMEZONE,
      };
}

function localDateTimeInputValue(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function formTextValue(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function buildGmailNewMessageEventConfig(
  form: FormData,
  baseConfig?: GmailNewMessageEventConfig,
): GmailNewMessageEventConfig {
  const baseMatch = baseConfig?.match;
  const match: GmailMatchRules = {};
  for (const { field } of GMAIL_TEXT_FIELDS) {
    const existing = baseMatch?.[field];
    const contains = formTextValue(form, `${field}Contains`);
    const doesNotContain = formTextValue(form, `${field}DoesNotContain`);
    const matcher: GmailTextMatcher = {};
    if (existing?.containsAny) {
      matcher.containsAny = existing.containsAny;
    }
    if (existing?.doesNotContainAny) {
      matcher.doesNotContainAny = existing.doesNotContainAny;
    }
    if (contains) {
      matcher.contains = contains;
    }
    if (doesNotContain) {
      matcher.doesNotContain = doesNotContain;
    }
    if (Object.keys(matcher).length > 0) {
      match[field] = matcher;
    }
  }
  return Object.keys(match).length > 0
    ? { provider: "gmail", event: "new_message", match }
    : { provider: "gmail", event: "new_message" };
}

function buildGmailLabelAppliedEventConfig(
  form: FormData,
): GmailLabelAppliedEventConfig | null {
  const labelName = formTextValue(form, "labelName");
  if (!labelName) {
    return null;
  }
  return {
    provider: "gmail",
    event: "label_applied",
    labelName,
  };
}

function quote(value: string): string {
  return `"${value}"`;
}

function quoteList(values: readonly string[]): string {
  return values.map(quote).join(", ");
}

function textMatcherParts(
  field: GmailTextField,
  matcher: GmailTextMatcher,
): string[] {
  const parts: string[] = [];
  if (matcher.contains) {
    parts.push(`${field} contains ${quote(matcher.contains)}`);
  }
  if (matcher.containsAny) {
    parts.push(`${field} contains any of ${quoteList(matcher.containsAny)}`);
  }
  if (matcher.doesNotContain) {
    parts.push(`${field} does not contain ${quote(matcher.doesNotContain)}`);
  }
  if (matcher.doesNotContainAny) {
    parts.push(
      `${field} does not contain any of ${quoteList(matcher.doesNotContainAny)}`,
    );
  }
  return parts;
}

function formatGmailMatchSummary(config: GmailNewMessageEventConfig): string {
  const match = config.match;
  if (!match) {
    return "all inbound messages";
  }

  const parts: string[] = [];
  for (const { field } of GMAIL_TEXT_FIELDS) {
    const matcher = match[field];
    if (matcher) {
      parts.push(...textMatcherParts(field, matcher));
    }
  }
  return parts.length > 0 ? parts.join("; ") : "all inbound messages";
}

function workflowTriggerTitle(trigger: ZeroWorkflowTriggerSummary): string {
  if (trigger.kind === "schedule") {
    return trigger.scheduleSummary;
  }
  if (trigger.eventType === "gmail-new-message") {
    return "Gmail new message";
  }
  if (trigger.eventType === "gmail-label-applied") {
    return "Gmail label applied";
  }
  return "Webhook";
}

function workflowTriggerSummary(
  trigger: ZeroWorkflowTriggerSummary,
): string | null {
  if (trigger.kind !== "event") {
    return null;
  }
  if (trigger.eventType === "gmail-new-message") {
    return formatGmailMatchSummary(trigger.eventConfig);
  }
  if (trigger.eventType === "gmail-label-applied") {
    return `Label ${quote(trigger.eventConfig.labelName)}`;
  }
  return null;
}

function gmailMatcherDefaultValue(
  config: GmailNewMessageEventConfig,
  field: GmailTextField,
  key: "contains" | "doesNotContain",
): string {
  return config.match?.[field]?.[key] ?? "";
}

type TriggerCreateDialogKind =
  | "interval"
  | "scheduled"
  | "gmail"
  | "gmail-label"
  | "webhook";

function TriggerCreateMenu({
  onSelect,
  webhookTriggersEnabled,
}: {
  readonly onSelect: (kind: TriggerCreateDialogKind) => void;
  readonly webhookTriggersEnabled: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="zero-btn-morandi inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs"
        >
          <IconPlus size={13} stroke={1.5} />
          <span>Add trigger</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuItem
          className="items-start gap-2 py-2"
          onSelect={() => {
            onSelect("interval");
          }}
        >
          <IconRepeat
            size={15}
            stroke={1.5}
            className="mt-0.5 shrink-0 text-muted-foreground"
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium">Interval</span>
            <span className="block text-xs text-muted-foreground">
              Run this workflow on a fixed interval.
            </span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className="items-start gap-2 py-2"
          onSelect={() => {
            onSelect("scheduled");
          }}
        >
          <IconClock
            size={15}
            stroke={1.5}
            className="mt-0.5 shrink-0 text-muted-foreground"
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium">Scheduled time</span>
            <span className="block text-xs text-muted-foreground">
              Run this workflow from a time rule.
            </span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className="items-start gap-2 py-2"
          onSelect={() => {
            onSelect("gmail");
          }}
        >
          <IconMail
            size={15}
            stroke={1.5}
            className="mt-0.5 shrink-0 text-muted-foreground"
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium">Gmail new message</span>
            <span className="block text-xs text-muted-foreground">
              Run this workflow from matching email.
            </span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className="items-start gap-2 py-2"
          onSelect={() => {
            onSelect("gmail-label");
          }}
        >
          <IconMail
            size={15}
            stroke={1.5}
            className="mt-0.5 shrink-0 text-muted-foreground"
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium">
              Gmail label applied
            </span>
            <span className="block text-xs text-muted-foreground">
              Run when a named Gmail label is applied.
            </span>
          </span>
        </DropdownMenuItem>
        {webhookTriggersEnabled ? (
          <DropdownMenuItem
            className="items-start gap-2 py-2"
            onSelect={() => {
              onSelect("webhook");
            }}
          >
            <IconLink
              size={15}
              stroke={1.5}
              className="mt-0.5 shrink-0 text-muted-foreground"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">Webhook</span>
              <span className="block text-xs text-muted-foreground">
                Run this workflow from a signed POST.
              </span>
            </span>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TriggersSection({
  detail,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
}) {
  const createDialog = useGet(workflowTriggerCreateDialog$);
  const setCreateDialog = useSet(setWorkflowTriggerCreateDialog$);
  const features = useGet(featureSwitch$);
  const userLoadable = useLoadable(user$);
  const preferences = useLastResolved(userPreferences$);
  const currentUserId =
    userLoadable.state === "hasData" ? (userLoadable.data?.id ?? "") : "";
  const displayTimezone = preferences?.timezone ?? browserTimezone();
  const triggers = detail.triggers;
  const webhookTriggersEnabled =
    features[FeatureSwitchKey.WorkflowWebhookTriggers] ?? false;

  return (
    <section className="mx-auto flex max-w-[900px] flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-sm font-medium text-foreground">Triggers</span>
          <span className="text-xs text-muted-foreground">
            {triggers.length}
          </span>
        </div>
        <TriggerCreateMenu
          onSelect={setCreateDialog}
          webhookTriggersEnabled={webhookTriggersEnabled}
        />
      </div>
      <div className="flex flex-col gap-2">
        {triggers.length > 0 ? (
          triggers.map((trigger) => {
            return (
              <TriggerRow
                key={trigger.id}
                trigger={trigger}
                canManage={trigger.ownerUserId === currentUserId}
                displayTimezone={displayTimezone}
              />
            );
          })
        ) : (
          <div className="zero-card px-5 py-4">
            <p className="text-sm text-muted-foreground">No triggers.</p>
          </div>
        )}
      </div>
      <CreateIntervalTriggerDialog
        workflowId={detail.id}
        open={createDialog === "interval"}
        onOpenChange={(open) => {
          setCreateDialog(open ? "interval" : null);
        }}
      />
      <CreateScheduledTriggerDialog
        workflowId={detail.id}
        displayTimezone={displayTimezone}
        open={createDialog === "scheduled"}
        onOpenChange={(open) => {
          setCreateDialog(open ? "scheduled" : null);
        }}
      />
      <CreateGmailNewMessageTriggerDialog
        workflowId={detail.id}
        open={createDialog === "gmail"}
        onOpenChange={(open) => {
          setCreateDialog(open ? "gmail" : null);
        }}
      />
      <CreateGmailLabelAppliedTriggerDialog
        workflowId={detail.id}
        open={createDialog === "gmail-label"}
        onOpenChange={(open) => {
          setCreateDialog(open ? "gmail-label" : null);
        }}
      />
      <CreateWebhookTriggerDialog
        workflowId={detail.id}
        open={createDialog === "webhook"}
        onOpenChange={(open) => {
          setCreateDialog(open ? "webhook" : null);
        }}
      />
    </section>
  );
}

function CreateIntervalTriggerDialog({
  workflowId,
  open,
  onOpenChange,
}: {
  readonly workflowId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [createLoadable, createScheduleTrigger] = useLoadableSet(
    createWorkflowScheduleTrigger$,
  );
  const creating = createLoadable.state === "loading";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add interval trigger</DialogTitle>
          <DialogDescription>
            Choose how often this workflow should run.
          </DialogDescription>
        </DialogHeader>
        <form
          aria-label="Add interval trigger"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const schedule = buildTriggerSchedule(
              "loop",
              {
                cronFields: defaultWorkflowCronFields(),
                intervalSeconds: String(form.get("intervalSeconds") ?? ""),
                atTime: "",
              },
              TRIGGER_TIMEZONE,
            );
            if (!schedule) {
              return;
            }
            detach(
              (async () => {
                await createScheduleTrigger(
                  { workflowId, schedule },
                  pageSignal,
                );
                onOpenChange(false);
              })(),
              Reason.DomCallback,
            );
          }}
        >
          <WorkflowIntervalField disabled={creating} />

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={creating}
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={creating}>
              {creating ? (
                <IconLoader2 size={14} className="animate-spin" />
              ) : null}
              Add interval
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreateScheduledTriggerDialog({
  workflowId,
  displayTimezone,
  open,
  onOpenChange,
}: {
  readonly workflowId: string;
  readonly displayTimezone: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const cronFields = useGet(createScheduleCronFields$);
  const setCronFields = useSet(setCreateScheduleCronFields$);
  const pageSignal = useGet(pageSignal$);
  const [createLoadable, createScheduleTrigger] = useLoadableSet(
    createWorkflowScheduleTrigger$,
  );
  const creating = createLoadable.state === "loading";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add schedule trigger</DialogTitle>
          <DialogDescription>
            Choose when this workflow should run.
          </DialogDescription>
        </DialogHeader>
        <form
          aria-label="Add schedule trigger"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const schedule = buildTriggerSchedule(
              "cron",
              {
                cronFields,
                intervalSeconds: "",
                atTime: String(form.get("atTime") ?? ""),
              },
              displayTimezone,
            );
            if (!schedule) {
              return;
            }
            detach(
              (async () => {
                await createScheduleTrigger(
                  { workflowId, schedule },
                  pageSignal,
                );
                onOpenChange(false);
              })(),
              Reason.DomCallback,
            );
          }}
        >
          <ScheduleTriggerFields
            scheduleType="cron"
            cronFields={cronFields}
            setCronFields={setCronFields}
            displayTimezone={displayTimezone}
            disabled={creating}
          />

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={creating}
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={creating}>
              {creating ? (
                <IconLoader2 size={14} className="animate-spin" />
              ) : null}
              Add schedule
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ScheduleTriggerFields({
  scheduleType,
  cronFields,
  setCronFields,
  displayTimezone,
  disabled,
  defaultIntervalSeconds,
  defaultAtTime,
}: {
  readonly scheduleType: ZeroWorkflowScheduleType;
  readonly cronFields: WorkflowCronFields;
  readonly setCronFields: (fields: WorkflowCronFields) => void;
  readonly displayTimezone: string;
  readonly disabled: boolean;
  readonly defaultIntervalSeconds?: number;
  readonly defaultAtTime?: string;
}) {
  if (scheduleType === "loop") {
    return (
      <WorkflowIntervalField
        disabled={disabled}
        defaultIntervalSeconds={defaultIntervalSeconds}
      />
    );
  }

  if (scheduleType === "once") {
    return (
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Run at
        <input
          name="atTime"
          aria-label="Run at"
          type="datetime-local"
          defaultValue={defaultAtTime}
          disabled={disabled}
          className={FIELD_CLASS}
        />
        <span className="text-xs text-muted-foreground">
          Uses {TRIGGER_TIMEZONE}.
        </span>
      </label>
    );
  }

  return (
    <WorkflowCronFieldsForm
      fields={cronFields}
      onChange={setCronFields}
      displayTimezone={displayTimezone}
      disabled={disabled}
    />
  );
}

function WorkflowIntervalField({
  disabled,
  defaultIntervalSeconds = 15 * 60,
}: {
  readonly disabled: boolean;
  readonly defaultIntervalSeconds?: number;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      Every
      <Select
        name="intervalSeconds"
        defaultValue={String(defaultIntervalSeconds)}
        disabled={disabled}
      >
        <SelectTrigger className="h-9 w-full" aria-label="Every">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {getWorkflowIntervalSecondOptions(defaultIntervalSeconds).map(
            (seconds) => {
              return (
                <SelectItem key={seconds} value={String(seconds)}>
                  {formatWorkflowIntervalSeconds(seconds)}
                </SelectItem>
              );
            },
          )}
        </SelectContent>
      </Select>
    </label>
  );
}

function WorkflowCronFieldsForm({
  fields,
  onChange,
  displayTimezone,
  disabled,
}: {
  readonly fields: WorkflowCronFields;
  readonly onChange: (fields: WorkflowCronFields) => void;
  readonly displayTimezone: string;
  readonly disabled: boolean;
}) {
  const updateFields = (patch: Partial<WorkflowCronFields>) => {
    onChange({ ...fields, ...patch });
  };
  return (
    <div className="flex flex-col gap-3">
      <WorkflowCronFrequencyField
        frequency={fields.frequency}
        disabled={disabled}
        onChange={(frequency) => {
          updateFields({ frequency });
        }}
      />

      {fields.frequency === "custom" ? (
        <WorkflowCustomCronField
          value={fields.customCronExpression}
          disabled={disabled}
          onChange={(customCronExpression) => {
            updateFields({ customCronExpression });
          }}
        />
      ) : (
        <>
          {fields.frequency === "every_week" ? (
            <WorkflowDayOfWeekPicker
              dayOfWeek={fields.dayOfWeek}
              disabled={disabled}
              onChange={(dayOfWeek) => {
                updateFields({ dayOfWeek });
              }}
            />
          ) : null}

          {fields.frequency === "every_month" ? (
            <WorkflowDayOfMonthField
              dayOfMonth={fields.dayOfMonth}
              disabled={disabled}
              onChange={(dayOfMonth) => {
                updateFields({ dayOfMonth });
              }}
            />
          ) : null}

          <WorkflowCronTimeField
            hour={fields.hour}
            minute={fields.minute}
            displayTimezone={displayTimezone}
            disabled={disabled}
            onHourChange={(hour) => {
              updateFields({ hour });
            }}
            onMinuteChange={(minute) => {
              updateFields({ minute });
            }}
          />
        </>
      )}
    </div>
  );
}

function WorkflowCronFrequencyField({
  frequency,
  disabled,
  onChange,
}: {
  readonly frequency: WorkflowCronFrequency;
  readonly disabled: boolean;
  readonly onChange: (frequency: WorkflowCronFrequency) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      Repeats
      <Select
        value={frequency}
        disabled={disabled}
        onValueChange={(value) => {
          onChange(value as WorkflowCronFrequency);
        }}
      >
        <SelectTrigger className="h-9 w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {WORKFLOW_CRON_FREQUENCY_OPTIONS.map((option) => {
            return (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </label>
  );
}

function WorkflowCustomCronField({
  value,
  disabled,
  onChange,
}: {
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      Cron expression
      <input
        aria-label="Cron expression"
        value={value}
        disabled={disabled}
        placeholder="0 9 * * *"
        className={FIELD_CLASS}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
      />
    </label>
  );
}

function WorkflowDayOfMonthField({
  dayOfMonth,
  disabled,
  onChange,
}: {
  readonly dayOfMonth: string;
  readonly disabled: boolean;
  readonly onChange: (dayOfMonth: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      Day of month
      <Select value={dayOfMonth} disabled={disabled} onValueChange={onChange}>
        <SelectTrigger className="h-9 w-full" aria-label="Day of month">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Array.from({ length: 31 }, (_, index) => {
            const day = String(index + 1);
            return (
              <SelectItem key={day} value={day}>
                {day}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </label>
  );
}

function WorkflowCronTimeField({
  hour,
  minute,
  displayTimezone,
  disabled,
  onHourChange,
  onMinuteChange,
}: {
  readonly hour: number;
  readonly minute: number;
  readonly displayTimezone: string;
  readonly disabled: boolean;
  readonly onHourChange: (hour: number) => void;
  readonly onMinuteChange: (minute: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">
        Time ({timezoneDisplayName(displayTimezone)})
      </span>
      <div className="flex items-center gap-2">
        <WorkflowNumberSelect
          value={hour}
          options={WORKFLOW_CRON_HOUR_OPTIONS}
          disabled={disabled}
          ariaLabel="Hour"
          onChange={onHourChange}
        />
        <span className="text-muted-foreground">:</span>
        <WorkflowNumberSelect
          value={minute}
          options={getWorkflowMinuteOptions(minute)}
          disabled={disabled}
          ariaLabel="Minute"
          onChange={onMinuteChange}
        />
      </div>
    </div>
  );
}

function WorkflowNumberSelect({
  value,
  options,
  disabled,
  ariaLabel,
  onChange,
}: {
  readonly value: number;
  readonly options: readonly number[];
  readonly disabled: boolean;
  readonly ariaLabel: string;
  readonly onChange: (value: number) => void;
}) {
  return (
    <Select
      value={String(value)}
      disabled={disabled}
      onValueChange={(nextValue) => {
        onChange(Number(nextValue));
      }}
    >
      <SelectTrigger className="h-9 w-20" aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => {
          return (
            <SelectItem key={option} value={String(option)}>
              {String(option).padStart(2, "0")}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

function WorkflowDayOfWeekPicker({
  dayOfWeek,
  disabled,
  onChange,
}: {
  readonly dayOfWeek: string;
  readonly disabled: boolean;
  readonly onChange: (dayOfWeek: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">Day of week</span>
      <div className="flex flex-wrap gap-1">
        {WORKFLOW_DAY_OF_WEEK_OPTIONS.map(([value, label]) => {
          const selected = dayOfWeek.split(",").includes(value);
          return (
            <button
              key={value}
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              className={cn(
                "h-8 min-w-10 rounded-md border px-2 text-xs font-medium transition-colors disabled:opacity-60",
                selected
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border/60 bg-background text-muted-foreground hover:bg-muted",
              )}
              onClick={() => {
                const current = dayOfWeek.split(",").filter(Boolean);
                if (selected) {
                  if (current.length <= 1) {
                    return;
                  }
                  onChange(
                    current
                      .filter((day) => {
                        return day !== value;
                      })
                      .join(","),
                  );
                  return;
                }
                onChange([...current, value].join(","));
              }}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CreateGmailNewMessageTriggerDialog({
  workflowId,
  open,
  onOpenChange,
}: {
  readonly workflowId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [createLoadable, createGmailTrigger] = useLoadableSet(
    createWorkflowGmailNewMessageTrigger$,
  );
  const creating = createLoadable.state === "loading";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add Gmail trigger</DialogTitle>
          <DialogDescription>
            Run this workflow when a matching message arrives.
          </DialogDescription>
        </DialogHeader>
        <form
          aria-label="Add Gmail trigger"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            detach(
              (async () => {
                await createGmailTrigger(
                  {
                    workflowId,
                    eventConfig: buildGmailNewMessageEventConfig(form),
                  },
                  pageSignal,
                );
                onOpenChange(false);
              })(),
              Reason.DomCallback,
            );
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {GMAIL_TEXT_FIELDS.map(({ field, label }) => {
              return (
                <div key={field} className="grid grid-cols-2 gap-2">
                  <input
                    name={`${field}Contains`}
                    aria-label={`${label} contains`}
                    disabled={creating}
                    placeholder={`${label} contains`}
                    className={FIELD_CLASS}
                  />
                  <input
                    name={`${field}DoesNotContain`}
                    aria-label={`${label} does not contain`}
                    disabled={creating}
                    placeholder={`${label} does not contain`}
                    className={FIELD_CLASS}
                  />
                </div>
              );
            })}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={creating}
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={creating}>
              {creating ? (
                <IconLoader2 size={14} className="animate-spin" />
              ) : null}
              Add Gmail trigger
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function signedWebhookCurlExample(
  trigger: WebhookWorkflowTriggerSummary,
): string {
  const secret = trigger.webhookSecret ?? "<signing-secret>";
  return [
    `BODY='{"hello":"world"}'`,
    "TIMESTAMP=$(date +%s)",
    `SIGNATURE=$(printf "%s.%s" "$TIMESTAMP" "$BODY" | openssl dgst -sha256 -hmac "${secret}" -hex | awk '{print $2}')`,
    `curl -X POST "${trigger.webhookUrl}" \\`,
    '  -H "Content-Type: application/json" \\',
    '  -H "X-VM0-Timestamp: $TIMESTAMP" \\',
    '  -H "X-VM0-Signature: $SIGNATURE" \\',
    '  --data "$BODY"',
  ].join("\n");
}

function CreateGmailLabelAppliedTriggerDialog({
  workflowId,
  open,
  onOpenChange,
}: {
  readonly workflowId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [createLoadable, createGmailLabelTrigger] = useLoadableSet(
    createWorkflowGmailLabelAppliedTrigger$,
  );
  const creating = createLoadable.state === "loading";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Gmail label trigger</DialogTitle>
          <DialogDescription>
            Run this workflow when a named Gmail label is applied.
          </DialogDescription>
        </DialogHeader>
        <form
          aria-label="Add Gmail label trigger"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const eventConfig = buildGmailLabelAppliedEventConfig(form);
            if (!eventConfig) {
              return;
            }
            detach(
              (async () => {
                await createGmailLabelTrigger(
                  { workflowId, eventConfig },
                  pageSignal,
                );
                onOpenChange(false);
              })(),
              Reason.DomCallback,
            );
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Label name
            <input
              name="labelName"
              aria-label="Label name"
              required
              disabled={creating}
              placeholder="Support"
              className={FIELD_CLASS}
            />
          </label>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={creating}
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={creating}>
              {creating ? (
                <IconLoader2 size={14} className="animate-spin" />
              ) : null}
              Add label trigger
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreateWebhookTriggerDialog({
  workflowId,
  open,
  onOpenChange,
}: {
  readonly workflowId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const createdTrigger = useGet(createdWorkflowWebhookTrigger$);
  const setCreatedTrigger = useSet(setCreatedWorkflowWebhookTrigger$);
  const reloadWorkflows = useSet(reloadWorkflows$);
  const [createLoadable, createWebhookTrigger] = useLoadableSet(
    createWorkflowWebhookTrigger$,
  );
  const creating = createLoadable.state === "loading";

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          if (createdTrigger) {
            reloadWorkflows();
          }
          setCreatedTrigger(null);
        }
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add webhook trigger</DialogTitle>
          <DialogDescription>
            Create a signed endpoint for this workflow.
          </DialogDescription>
        </DialogHeader>
        {createdTrigger ? (
          <CreatedWebhookTriggerView
            trigger={createdTrigger}
            onDone={() => {
              reloadWorkflows();
              setCreatedTrigger(null);
              onOpenChange(false);
            }}
          />
        ) : (
          <CreateWebhookTriggerView
            creating={creating}
            onCancel={() => {
              onOpenChange(false);
            }}
            onCreate={() => {
              detach(
                (async () => {
                  const trigger = await createWebhookTrigger(
                    { workflowId },
                    pageSignal,
                  );
                  setCreatedTrigger(trigger);
                })(),
                Reason.DomCallback,
              );
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function CreatedWebhookTriggerView({
  trigger,
  onDone,
}: {
  readonly trigger: WebhookWorkflowTriggerSummary;
  readonly onDone: () => void;
}) {
  const curlExample = signedWebhookCurlExample(trigger);
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Webhook URL
        <WebhookReadonlyField
          value={trigger.webhookUrl}
          onCopy={() => {
            copyText(trigger.webhookUrl);
          }}
        />
      </label>
      {trigger.webhookSecret ? (
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Signing secret
          <WebhookReadonlyField
            value={trigger.webhookSecret}
            onCopy={() => {
              copyText(trigger.webhookSecret ?? "");
            }}
          />
        </label>
      ) : null}
      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        Signed curl
        <div className="relative">
          <pre className="max-h-56 overflow-auto rounded-md border border-border/60 bg-muted/40 p-3 text-xs leading-5 text-foreground">
            {curlExample}
          </pre>
          <Button
            type="button"
            variant="outline"
            className="absolute right-2 top-2 h-7 px-2 text-xs"
            onClick={() => {
              copyText(curlExample);
            }}
          >
            <IconCopy size={13} />
            Copy
          </Button>
        </div>
      </div>
      <DialogFooter>
        <Button type="button" onClick={onDone}>
          Done
        </Button>
      </DialogFooter>
    </div>
  );
}

function WebhookReadonlyField({
  value,
  onCopy,
}: {
  readonly value: string;
  readonly onCopy: () => void;
}) {
  return (
    <div className="flex min-w-0 gap-2">
      <input readOnly value={value} className={FIELD_CLASS} />
      <Button type="button" variant="outline" onClick={onCopy}>
        <IconCopy size={14} />
        Copy
      </Button>
    </div>
  );
}

function CreateWebhookTriggerView({
  creating,
  onCancel,
  onCreate,
}: {
  readonly creating: boolean;
  readonly onCancel: () => void;
  readonly onCreate: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
        The signing secret is shown only after creation.
      </div>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={creating}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="button" disabled={creating} onClick={onCreate}>
          {creating ? <IconLoader2 size={14} className="animate-spin" /> : null}
          Create webhook
        </Button>
      </DialogFooter>
    </div>
  );
}

function TriggerRow({
  trigger,
  canManage,
  displayTimezone,
}: {
  readonly trigger: ZeroWorkflowTriggerSummary;
  readonly canManage: boolean;
  readonly displayTimezone: string;
}) {
  const editingTriggerId = useGet(editingWorkflowTriggerId$);
  const setEditingTriggerId = useSet(setEditingWorkflowTriggerId$);
  const editing = editingTriggerId === trigger.id;
  const rows = triggerCardRows(trigger, displayTimezone);

  return (
    <>
      <WorkflowTriggerCard
        rows={rows}
        dimmed={!trigger.enabled}
        actions={
          canManage ? (
            <TriggerControls
              trigger={trigger}
              displayTimezone={displayTimezone}
            />
          ) : null
        }
      />
      {canManage ? (
        <EditWorkflowTriggerDialog
          trigger={trigger}
          displayTimezone={displayTimezone}
          open={editing}
          onOpenChange={(open) => {
            if (!open) {
              setEditingTriggerId(null);
            }
          }}
        />
      ) : null}
    </>
  );
}

function triggerCardRows(
  trigger: ZeroWorkflowTriggerSummary,
  displayTimezone: string,
): readonly WorkflowTriggerCardRow[] {
  const rows: WorkflowTriggerCardRow[] = [
    {
      label: trigger.kind === "schedule" ? "Schedule" : "Trigger",
      value: workflowScheduleTitle(trigger, displayTimezone),
    },
    {
      label: "Last run",
      value: formatWorkflowTriggerRun(trigger.lastRunAt, displayTimezone),
    },
    {
      label: "Next run",
      value: formatWorkflowTriggerNextRun(trigger.nextRunAt, displayTimezone),
    },
  ];

  const matchSummary = workflowTriggerSummary(trigger);
  if (matchSummary) {
    rows.splice(1, 0, { label: "Match", value: matchSummary });
  }

  if (isWebhookWorkflowTrigger(trigger)) {
    rows.splice(1, 0, {
      label: "Webhook",
      value: trigger.webhookUrl,
    });
  }

  return rows;
}

function formatWorkflowTriggerRun(
  value: string | null,
  displayTimezone: string,
): string {
  if (!value) {
    return "No runs yet";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "No runs yet";
  }

  return date.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: displayTimezone,
  });
}

function formatWorkflowTriggerNextRun(
  value: string | null,
  displayTimezone: string,
): string {
  if (!value) {
    return "No upcoming run";
  }

  return formatWorkflowTriggerRun(value, displayTimezone);
}

function TriggerToggleIcon({ enabled }: { readonly enabled: boolean }) {
  return enabled ? (
    <IconPlayerPause size={13} stroke={1.5} />
  ) : (
    <IconPlayerPlay size={13} stroke={1.5} />
  );
}

function TriggerControls({
  trigger,
  displayTimezone,
}: {
  readonly trigger: ZeroWorkflowTriggerSummary;
  readonly displayTimezone: string;
}) {
  const pageSignal = useGet(pageSignal$);
  const setEditingTriggerId = useSet(setEditingWorkflowTriggerId$);
  const setEditingScheduleCronFields = useSet(setEditingScheduleCronFields$);
  const [enabledLoadable, setEnabled] = useLoadableSet(
    setWorkflowTriggerEnabled$,
  );
  const [deleteLoadable, deleteTrigger] = useLoadableSet(
    deleteWorkflowTrigger$,
  );
  const [runNowLoadable, runNow] = useLoadableSet(runWorkflowTriggerNow$);
  const busy =
    enabledLoadable.state === "loading" ||
    deleteLoadable.state === "loading" ||
    runNowLoadable.state === "loading";
  const running = runNowLoadable.state === "loading";
  const canEdit = canEditWorkflowTrigger(trigger);

  return (
    <>
      {canEdit ? (
        <button
          type="button"
          disabled={busy}
          className="rounded-md px-1 py-1 text-sm font-medium text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline disabled:opacity-60"
          onClick={() => {
            if (
              trigger.kind === "schedule" &&
              trigger.schedule.type === "cron"
            ) {
              setEditingScheduleCronFields(
                parseWorkflowCronFields(trigger.schedule, displayTimezone),
              );
            }
            setEditingTriggerId(trigger.id);
          }}
        >
          Edit
        </button>
      ) : null}
      <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          className="zero-btn-morandi h-8 gap-1.5 rounded-lg px-3 text-xs font-medium"
          onClick={() => {
            detach(
              runNow(trigger.id, pageSignal),
              Reason.DomCallback,
              "run workflow trigger now",
            );
          }}
        >
          {running ? (
            <IconLoader2 size={13} className="animate-spin" />
          ) : (
            <IconPlayerPlay size={13} stroke={1.5} />
          )}
          <span>{running ? "Starting..." : "Run now"}</span>
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          className="zero-btn-morandi h-8 gap-1.5 rounded-lg px-3 text-xs font-medium"
          onClick={() => {
            detach(
              setEnabled(
                { triggerId: trigger.id, enabled: !trigger.enabled },
                pageSignal,
              ),
              Reason.DomCallback,
            );
          }}
        >
          <TriggerToggleIcon enabled={trigger.enabled} />
          <span>{trigger.enabled ? "Pause" : "Resume"}</span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          className="h-8 gap-1.5 rounded-lg px-3 text-xs font-medium text-destructive/80 hover:bg-destructive/10 hover:text-destructive"
          onClick={() => {
            detach(deleteTrigger(trigger.id, pageSignal), Reason.DomCallback);
          }}
        >
          <IconTrash size={13} stroke={1.5} />
          <span>Delete</span>
        </Button>
      </div>
    </>
  );
}

function canEditWorkflowTrigger(trigger: ZeroWorkflowTriggerSummary): boolean {
  return trigger.kind === "schedule" || isGmailWorkflowTrigger(trigger);
}

function editWorkflowTriggerTitle(trigger: ZeroWorkflowTriggerSummary): string {
  if (trigger.kind === "schedule") {
    return "Edit schedule";
  }

  return trigger.eventType === "gmail-label-applied"
    ? "Edit label"
    : "Edit match";
}

function EditWorkflowTriggerDialog({
  trigger,
  displayTimezone,
  open,
  onOpenChange,
}: {
  readonly trigger: ZeroWorkflowTriggerSummary;
  readonly displayTimezone: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const close = () => {
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={isGmailWorkflowTrigger(trigger) ? "max-w-2xl" : ""}
      >
        <DialogHeader>
          <DialogTitle>{editWorkflowTriggerTitle(trigger)}</DialogTitle>
          <DialogDescription>Update this trigger.</DialogDescription>
        </DialogHeader>
        {trigger.kind === "schedule" ? (
          <UpdateScheduleTriggerForm
            trigger={trigger}
            displayTimezone={displayTimezone}
            onCancel={close}
          />
        ) : null}
        {trigger.kind === "event" &&
        trigger.eventType === "gmail-new-message" ? (
          <UpdateGmailNewMessageTriggerForm
            trigger={trigger}
            onCancel={close}
          />
        ) : null}
        {trigger.kind === "event" &&
        trigger.eventType === "gmail-label-applied" ? (
          <UpdateGmailLabelAppliedTriggerForm
            trigger={trigger}
            onCancel={close}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function UpdateScheduleTriggerForm({
  trigger,
  displayTimezone,
  onCancel,
}: {
  readonly trigger: Extract<ZeroWorkflowTriggerSummary, { kind: "schedule" }>;
  readonly displayTimezone: string;
  readonly onCancel: () => void;
}) {
  const cronFields = useGet(editingScheduleCronFields$);
  const setCronFields = useSet(setEditingScheduleCronFields$);
  const pageSignal = useGet(pageSignal$);
  const [updateLoadable, updateScheduleTrigger] = useLoadableSet(
    updateWorkflowScheduleTrigger$,
  );
  const saving = updateLoadable.state === "loading";
  const schedule = trigger.schedule;

  return (
    <form
      aria-label="Update schedule trigger"
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const scheduleValue = buildTriggerSchedule(
          schedule.type,
          {
            cronFields,
            intervalSeconds: String(form.get("intervalSeconds") ?? ""),
            atTime: String(form.get("atTime") ?? ""),
          },
          displayTimezone,
        );
        if (!scheduleValue) {
          return;
        }
        detach(
          (async () => {
            await updateScheduleTrigger(
              {
                triggerId: trigger.id,
                schedule: scheduleValue,
              },
              pageSignal,
            );
            onCancel();
          })(),
          Reason.DomCallback,
        );
      }}
    >
      <ScheduleTriggerFields
        scheduleType={schedule.type}
        cronFields={cronFields}
        setCronFields={setCronFields}
        displayTimezone={displayTimezone}
        defaultIntervalSeconds={
          schedule.type === "loop" ? schedule.intervalSeconds : undefined
        }
        defaultAtTime={
          schedule.type === "once"
            ? localDateTimeInputValue(schedule.atTime)
            : undefined
        }
        disabled={saving}
      />
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={saving}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? (
            <IconLoader2 size={13} className="animate-spin" />
          ) : (
            <IconClock size={13} stroke={1.5} />
          )}
          <span>Save schedule</span>
        </Button>
      </DialogFooter>
    </form>
  );
}

function UpdateGmailNewMessageTriggerForm({
  trigger,
  onCancel,
}: {
  readonly trigger: Extract<
    ZeroWorkflowTriggerSummary,
    { eventType: "gmail-new-message" }
  >;
  readonly onCancel: () => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [updateLoadable, updateGmailTrigger] = useLoadableSet(
    updateWorkflowGmailNewMessageTrigger$,
  );
  const saving = updateLoadable.state === "loading";

  return (
    <form
      aria-label="Update Gmail new message trigger"
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        detach(
          (async () => {
            await updateGmailTrigger(
              {
                triggerId: trigger.id,
                eventConfig: buildGmailNewMessageEventConfig(
                  form,
                  trigger.eventConfig,
                ),
              },
              pageSignal,
            );
            onCancel();
          })(),
          Reason.DomCallback,
        );
      }}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        {GMAIL_TEXT_FIELDS.map(({ field, label }) => {
          return (
            <div key={field} className="grid grid-cols-2 gap-1.5">
              <input
                name={`${field}Contains`}
                aria-label={`${label} contains`}
                defaultValue={gmailMatcherDefaultValue(
                  trigger.eventConfig,
                  field,
                  "contains",
                )}
                disabled={saving}
                placeholder={`${label} contains`}
                className={TRIGGER_FIELD_CLASS}
              />
              <input
                name={`${field}DoesNotContain`}
                aria-label={`${label} does not contain`}
                defaultValue={gmailMatcherDefaultValue(
                  trigger.eventConfig,
                  field,
                  "doesNotContain",
                )}
                disabled={saving}
                placeholder={`${label} does not contain`}
                className={TRIGGER_FIELD_CLASS}
              />
            </div>
          );
        })}
      </div>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={saving}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? (
            <IconLoader2 size={13} className="animate-spin" />
          ) : (
            <IconMail size={13} stroke={1.5} />
          )}
          <span>Save match</span>
        </Button>
      </DialogFooter>
    </form>
  );
}

function UpdateGmailLabelAppliedTriggerForm({
  trigger,
  onCancel,
}: {
  readonly trigger: Extract<
    ZeroWorkflowTriggerSummary,
    { eventType: "gmail-label-applied" }
  >;
  readonly onCancel: () => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [updateLoadable, updateGmailLabelTrigger] = useLoadableSet(
    updateWorkflowGmailLabelAppliedTrigger$,
  );
  const saving = updateLoadable.state === "loading";

  return (
    <form
      aria-label="Update Gmail label trigger"
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const eventConfig = buildGmailLabelAppliedEventConfig(form);
        if (!eventConfig) {
          return;
        }
        detach(
          (async () => {
            await updateGmailLabelTrigger(
              {
                triggerId: trigger.id,
                eventConfig,
              },
              pageSignal,
            );
            onCancel();
          })(),
          Reason.DomCallback,
        );
      }}
    >
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Label name
        <input
          name="labelName"
          aria-label="Label name"
          required
          defaultValue={trigger.eventConfig.labelName}
          disabled={saving}
          placeholder="Support"
          className={TRIGGER_FIELD_CLASS}
        />
      </label>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={saving}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? (
            <IconLoader2 size={13} className="animate-spin" />
          ) : (
            <IconMail size={13} stroke={1.5} />
          )}
          <span>Save label</span>
        </Button>
      </DialogFooter>
    </form>
  );
}

function DetailSkeleton() {
  return (
    <DetailPageShell scroll={false}>
      <WorkflowBreadcrumb detail={null} />
      <DetailPageHeader className="pb-3">
        <div className="animate-pulse space-y-3">
          <div className="h-5 w-48 rounded bg-muted" />
          <div className="h-4 w-72 rounded bg-muted" />
          <div className="mt-4 h-9 w-80 rounded bg-muted" />
        </div>
      </DetailPageHeader>
    </DetailPageShell>
  );
}
