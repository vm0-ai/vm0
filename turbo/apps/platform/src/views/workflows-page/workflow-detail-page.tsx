// Workflow detail hosts the instruction editor, supplementary file manager
// (SKILL.md is never shown), automations, visibility controls, metadata
// editing, slash use, copy, and delete.
import type { FormEvent, ReactNode } from "react";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type {
  GmailLabelAppliedEventConfig,
  GmailNewMessageEventConfig,
  GithubDeploymentState,
  GithubDeploymentStatusCreatedEventConfig,
  GithubIssueCommentCreatedEventConfig,
  GithubLabelAppliedEventConfig,
  GithubLabelAppliedSubjectFilter,
  GithubPullRequestReviewState,
  GithubPullRequestReviewSubmittedEventConfig,
  GithubWorkflowJobCompletedEventConfig,
  GithubWorkflowRunCompletedEventConfig,
  GithubWorkflowRunConclusion,
  NotionPageContentUpdatedEventCreateConfig,
  WorkflowFileEntry,
  WorkflowFileMetadata,
  ZeroWorkflowConnectorReadinessEntry,
  ZeroWorkflowDetailResponse,
  ZeroWorkflowSchedule,
  ZeroWorkflowScheduleType,
  ZeroWorkflowAutomationSummary,
  ZeroWorkflowUpdateRequest,
} from "@vm0/api-contracts/contracts/zero-workflows";
import {
  IconAlertTriangle,
  IconBrandGithub,
  IconBrandNotion,
  IconCalendarTime,
  IconCircleCheck,
  IconChevronDown,
  IconClock,
  IconCopy,
  IconDatabasePlus,
  IconFilePencil,
  IconFilePlus,
  IconFileText,
  IconHistory,
  IconInfoCircle,
  IconLink,
  IconLoader2,
  IconMail,
  IconMessageCircle,
  IconPlayerPlay,
  IconPlus,
  IconPencil,
  IconRepeat,
  IconRoute,
  IconTrash,
  IconUpload,
  IconDotsVertical,
  IconEye,
  IconExternalLink,
  IconPlugConnected,
  IconVideo,
  IconX,
} from "@tabler/icons-react";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import {
  Button,
  Checkbox,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui";
import { DropdownMenuModalItem } from "../components/dropdown-menu-modal-item.tsx";

import { agents$ } from "../../signals/agent.ts";
import { user$ } from "../../signals/auth.ts";
import {
  changeWorkflowVisibility$,
  checkWorkflowConnectorReadiness$,
  createNotionPageContentUpdatedScope$,
  createWorkflowGithubLabelAppliedAutomation$,
  createWorkflowGithubWebhookAutomation$,
  createWorkflowGithubWorkflowRunCompletedAutomation$,
  createWorkflowGoogleCalendarEventAutomation$,
  createWorkflowGoogleMeetTranscriptGeneratedAutomation$,
  createWorkflowGmailLabelAppliedAutomation$,
  createWorkflowGmailNewMessageAutomation$,
  createGmailMatchConditions$,
  createWorkflowNotionChildPageAutomation$,
  createWorkflowNotionDatabaseItemAutomation$,
  createWorkflowNotionPageContentUpdatedAutomation$,
  createWorkflowWebhookAutomation$,
  createGithubLabelActor$,
  createScheduleCronFields$,
  createWorkflowScheduleAutomation$,
  createdWorkflowWebhookAutomation$,
  currentWorkflowId$,
  copyWorkflow$,
  defaultWorkflowCronFields,
  deleteWorkflow$,
  deleteWorkflowAutomation$,
  editingScheduleCronFields$,
  editingGithubLabelActors$,
  editingGmailMatchConditions$,
  editingWorkflowAutomationId$,
  patchWorkflowMetadataForm$,
  openWorkflowChat$,
  pauseWorkflowAutomations$,
  reloadWorkflows$,
  revealWebhookSecretAutomationId$,
  revealWorkflowWebhookSecret$,
  resetWorkflowMetadataForm$,
  runWorkflowAutomationNow$,
  selectedWorkflowFilePath$,
  setCreateGithubLabelActor$,
  setCreateGmailMatchConditions$,
  setCreateNotionPageContentUpdatedScope$,
  setCreateScheduleCronFields$,
  setCreatedWorkflowWebhookAutomation$,
  setEditingGithubLabelActor$,
  setEditingGmailMatchConditions$,
  setEditingScheduleCronFields$,
  setEditingWorkflowAutomationId$,
  setRevealWebhookSecretAutomationId$,
  setSelectedWorkflowFilePath$,
  setWorkflowActionDialog$,
  setWorkflowDetailActiveTab$,
  setWorkflowFileDraft$,
  setWorkflowCopyForm$,
  setWorkflowAutomationCreateDialog$,
  setWorkflowAutomationEnabled$,
  updateWorkflowGithubLabelAppliedAutomation$,
  updateWorkflowGithubWebhookAutomation$,
  updateWorkflowGithubWorkflowRunCompletedAutomation$,
  updateWorkflowGmailNewMessageAutomation$,
  updateWorkflowGmailLabelAppliedAutomation$,
  updateWorkflowScheduleAutomation$,
  updateWorkflow$,
  workflowActionDialog$,
  workflowDemoteConfirmOpen$,
  setWorkflowDemoteConfirmOpen$,
  setWorkflowAutomationPickerCategory$,
  setWorkflowAutomationPickerOpen$,
  setWorkflowWebhookUpgradeDialogOpen$,
  workflowCopyForm$,
  workflowDetailActiveTab$,
  workflowAutomationCreateDialog$,
  workflowAutomationPickerCategory$,
  workflowAutomationPickerOpen$,
  workflowFileDraft$,
  currentWorkflowDetail$,
  type WorkflowCopyFormState,
  type WorkflowCronFields,
  type WorkflowCronFrequency,
  type WorkflowDetailTab,
  type WorkflowAutomationCreateDialog,
  type NotionPageContentUpdatedScopeMode,
  type GmailMatchCondition,
  type GmailTextField,
  type GmailTextOperator,
  workflowMetadataPatch$,
  workflowConnectorReadiness$,
} from "../../signals/workflows-page/workflows-signals.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import {
  detachedNavigateTo$,
  generateRouterPath,
} from "../../signals/route.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { writeToClipboard } from "../../signals/zero-page/clipboard.ts";
import { orgPlanCapabilities$ } from "../../signals/zero-page/org-plan-capabilities.ts";
import {
  connectGithubInstallation$,
  githubIntegrationData$,
} from "../../signals/zero-page/zero-github.ts";
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
import { LoadingSwitch } from "../components/loading-switch.tsx";
import { TiptapInstructionsEditor } from "../zero-page/tiptap-instructions-editor.tsx";
import { ZeroUnsavedBar } from "../zero-page/zero-unsaved-bar.tsx";
import { InlineSettingsRow } from "../zero-page/components/zero-inline-settings-row.tsx";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@vm0/ui/components/ui/alert";
import {
  agentLabel,
  formatWorkflowIntervalSeconds,
  getWorkflowIntervalSecondOptions,
  isMarkdownPath,
  automationKindLabel,
  workflowTitle,
} from "./workflow-shared.tsx";
import { WorkflowHoverContent } from "./workflows-page.tsx";
import { AutomationListIcon } from "../zero-page/workflow-automations-page.tsx";
import { emptyAutomationsImg } from "../zero-page/platform-assets.ts";
import { ConnectorIcon } from "../zero-page/components/settings/connector-icons.tsx";
import { WorkflowWebhookUpgradeDialog } from "./workflow-webhook-upgrade-dialog.tsx";

const FIELD_CLASS =
  "h-9 w-full rounded-md border border-border/60 bg-background px-2.5 text-sm outline-none focus:border-primary";
const AUTOMATION_FIELD_CLASS =
  "h-8 w-full rounded-md border border-border/60 bg-background px-2 text-xs";
const WORKFLOW_EDIT_TEXTAREA_CLASS =
  "min-h-24 w-full resize-y rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-input px-3 py-2 text-sm text-foreground placeholder:text-sm placeholder:text-muted-foreground outline-none transition-colors focus:border-primary focus:ring-[3px] focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-50";
const AUTOMATION_TIMEZONE = "UTC";

type GmailMatchRules = NonNullable<GmailNewMessageEventConfig["match"]>;
type GmailTextMatcher = NonNullable<GmailMatchRules["from"]>;
type GmailWorkflowAutomationSummary = Extract<
  ZeroWorkflowAutomationSummary,
  {
    readonly kind: "event";
    readonly eventType: "gmail-new-message" | "gmail-label-applied";
  }
>;
type GithubWorkflowAutomationSummary = Extract<
  ZeroWorkflowAutomationSummary,
  {
    readonly kind: "event";
    readonly eventType:
      | "github-label-applied"
      | "github-deployment-status-created"
      | "github-issue-comment-created"
      | "github-pull-request-review-submitted"
      | "github-workflow-job-completed"
      | "github-workflow-run-completed";
  }
>;
type GithubWebhookWorkflowAutomationSummary = Extract<
  GithubWorkflowAutomationSummary,
  {
    readonly eventType:
      | "github-deployment-status-created"
      | "github-issue-comment-created"
      | "github-pull-request-review-submitted"
      | "github-workflow-job-completed";
  }
>;
type WebhookWorkflowAutomationSummary = Extract<
  ZeroWorkflowAutomationSummary,
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

const GMAIL_TEXT_OPERATORS: readonly {
  readonly operator: GmailTextOperator;
  readonly label: string;
}[] = [
  { operator: "contains", label: "Contains" },
  { operator: "doesNotContain", label: "Does not contain" },
];

const GITHUB_SUBJECT_OPTIONS: readonly {
  readonly value: GithubLabelAppliedSubjectFilter;
  readonly label: string;
}[] = [
  { value: "both", label: "Issues and pull requests" },
  { value: "issues", label: "Issues only" },
  { value: "pull_requests", label: "Pull requests only" },
];

const GITHUB_ACTOR_OPTIONS: readonly {
  readonly value: "me" | "anyone";
  readonly label: string;
}[] = [
  { value: "me", label: "Me" },
  { value: "anyone", label: "Anyone" },
];

const GITHUB_WORKFLOW_RUN_CONCLUSION_OPTIONS: readonly {
  readonly value: GithubWorkflowRunConclusion;
  readonly label: string;
}[] = [
  { value: "success", label: "Success" },
  { value: "failure", label: "Failure" },
  { value: "cancelled", label: "Cancelled" },
  { value: "timed_out", label: "Timed out" },
  { value: "action_required", label: "Action required" },
  { value: "neutral", label: "Neutral" },
  { value: "skipped", label: "Skipped" },
  { value: "stale", label: "Stale" },
  { value: "startup_failure", label: "Startup failure" },
];

const GITHUB_REVIEW_STATE_OPTIONS: readonly {
  readonly value: GithubPullRequestReviewState;
  readonly label: string;
}[] = [
  { value: "approved", label: "Approved" },
  { value: "changes_requested", label: "Changes requested" },
  { value: "commented", label: "Commented" },
];

const GITHUB_DEPLOYMENT_STATE_OPTIONS: readonly {
  readonly value: GithubDeploymentState;
  readonly label: string;
}[] = [
  { value: "success", label: "Success" },
  { value: "failure", label: "Failure" },
  { value: "error", label: "Error" },
  { value: "pending", label: "Pending" },
  { value: "in_progress", label: "In progress" },
  { value: "queued", label: "Queued" },
  { value: "waiting", label: "Waiting" },
  { value: "inactive", label: "Inactive" },
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

function isGmailWorkflowAutomation(
  automation: ZeroWorkflowAutomationSummary,
): automation is GmailWorkflowAutomationSummary {
  return (
    automation.kind === "event" &&
    (automation.eventType === "gmail-new-message" ||
      automation.eventType === "gmail-label-applied")
  );
}

function isGithubWorkflowAutomation(
  automation: ZeroWorkflowAutomationSummary,
): automation is GithubWorkflowAutomationSummary {
  return (
    automation.kind === "event" &&
    (automation.eventType === "github-label-applied" ||
      automation.eventType === "github-deployment-status-created" ||
      automation.eventType === "github-issue-comment-created" ||
      automation.eventType === "github-pull-request-review-submitted" ||
      automation.eventType === "github-workflow-job-completed" ||
      automation.eventType === "github-workflow-run-completed")
  );
}

function isGithubWebhookWorkflowAutomation(
  automation: ZeroWorkflowAutomationSummary,
): automation is GithubWebhookWorkflowAutomationSummary {
  return (
    automation.kind === "event" &&
    (automation.eventType === "github-deployment-status-created" ||
      automation.eventType === "github-issue-comment-created" ||
      automation.eventType === "github-pull-request-review-submitted" ||
      automation.eventType === "github-workflow-job-completed")
  );
}

function isWebhookWorkflowAutomation(
  automation: ZeroWorkflowAutomationSummary,
): automation is WebhookWorkflowAutomationSummary {
  return (
    automation.kind === "event" && automation.eventType === "webhook-received"
  );
}

function copyText(value: string): void {
  detach(writeToClipboard(value), Reason.DomCallback);
}

export function WorkflowDetailPage() {
  const workflowId = useGet(currentWorkflowId$);

  if (!workflowId) {
    return null;
  }

  return <WorkflowDetailContent />;
}

function WorkflowDetailContent() {
  const detail$ = currentWorkflowDetail$;
  const detailLoadable = useLoadable(detail$);
  const lastResolvedDetail = useLastResolved(detail$);
  const detail =
    detailLoadable.state === "hasData"
      ? detailLoadable.data
      : (lastResolvedDetail ?? null);
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
        pathname={ROUTES.workflows}
        icon={<IconRoute size={14} stroke={1.5} className="shrink-0" />}
      >
        Workflows
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

function WorkflowHeaderIcon({
  automation,
}: {
  readonly automation: ZeroWorkflowAutomationSummary | undefined;
}) {
  if (automation) {
    return <AutomationListIcon automation={automation} size="md" />;
  }
  return (
    <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gray-100 text-muted-foreground sm:h-16 sm:w-16">
      <IconRoute size={28} stroke={1.7} />
    </span>
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
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <WorkflowHeaderIcon automation={detail.automations[0]} />
              <div className="flex min-w-0 flex-col justify-center">
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <h1 className="w-fit max-w-full cursor-help truncate text-lg font-semibold tracking-tight text-foreground underline decoration-foreground/40 decoration-dotted decoration-[1px] underline-offset-2 sm:text-xl">
                        {workflowTitle(detail)}
                      </h1>
                    </TooltipTrigger>
                    <TooltipContent
                      side="bottom"
                      align="start"
                      className="rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] p-3"
                      style={{
                        backgroundColor: "hsl(var(--card))",
                        color: "hsl(var(--card-foreground))",
                        boxShadow:
                          "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)",
                      }}
                    >
                      <WorkflowHoverContent workflow={detail} />
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <p className="mt-1.5 max-w-full truncate text-sm text-muted-foreground">
                  /{detail.name}
                </p>
              </div>
            </div>
            <WorkflowChatButton detail={detail} />
          </div>
          <div className="mt-4 flex items-center gap-2 sm:mt-6">
            <WorkflowTabNav activeTab={activeTab} onTabChange={onTabChange} />
            {activeTab === "automations" ? <AutomationCreateAction /> : null}
            {activeTab === "instructions" ? (
              <WorkflowFilePicker detail={detail} />
            ) : null}
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
            <SelectItem value="automations">Automations</SelectItem>
            <SelectItem value="instructions">Instructions</SelectItem>
            <SelectItem value="info">Settings</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <TabsList className="zero-tabs hidden h-9 gap-1 px-1 py-1 sm:inline-flex">
        <TabsTrigger value="automations" className={WORKFLOW_TAB_TRIGGER_CLASS}>
          <IconClock size={14} stroke={1.5} />
          Automations
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
          Settings
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

function AutomationCreateAction() {
  const setCreateDialog = useSet(setWorkflowAutomationCreateDialog$);
  const setWebhookUpgradeDialogOpen = useSet(
    setWorkflowWebhookUpgradeDialogOpen$,
  );
  const features = useGet(featureSwitch$);
  const capabilities = useLastResolved(orgPlanCapabilities$);
  const webhookTierEligible =
    capabilities?.workflowWebhookAutomationAllowed ?? true;
  const notionWorkflowAutomationsEnabled =
    features[FeatureSwitchKey.NotionWorkflowAutomations] ?? false;
  const githubWebhookAutomationsEnabled =
    features[FeatureSwitchKey.GithubWebhookAutomations] ?? false;

  return (
    <AutomationCreateMenu
      onSelect={(kind) => {
        if (kind === "webhook" && !webhookTierEligible) {
          setWebhookUpgradeDialogOpen(true);
          return;
        }
        setCreateDialog(kind);
      }}
      githubLabelAutomationsEnabled
      githubWebhookAutomationsEnabled={githubWebhookAutomationsEnabled}
      googleCalendarAutomationsEnabled
      googleMeetAutomationsEnabled
      notionWorkflowAutomationsEnabled={notionWorkflowAutomationsEnabled}
      webhookTierEligible={webhookTierEligible}
    />
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
  const chatLabel = `Refine with ${agentLabel(detail)}`;

  return (
    <Button
      variant="outline"
      size="sm"
      type="button"
      aria-label={chatLabel}
      className="zero-btn-morandi max-w-[220px] shrink-0 gap-1.5"
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
        <IconLoader2 size={14} className="shrink-0 animate-spin" />
      ) : (
        <IconMessageCircle size={14} stroke={2} className="shrink-0" />
      )}
      <span className="truncate">{chatLabel}</span>
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
      case "automations": {
        return <AutomationsSection detail={detail} />;
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

function WorkflowInfoTab({
  detail,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
}) {
  const actionDialog = useGet(workflowActionDialog$);
  const setActionDialog = useSet(setWorkflowActionDialog$);
  const features = useGet(featureSwitch$);
  const metadataPatch = useGet(workflowMetadataPatch$);
  const fileDraft = useGet(workflowFileDraft$);
  const connectorReadinessEnabled =
    features[FeatureSwitchKey.WorkflowConnectorReadiness] ?? false;
  const hasUnsavedReadinessInputs = hasUnsavedConnectorReadinessInputs(
    detail,
    metadataPatch,
    fileDraft,
  );

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-4">
      <WorkflowMetadataForm detail={detail} />
      {connectorReadinessEnabled ? (
        <WorkflowConnectorReadiness
          detail={detail}
          hasUnsavedInputs={hasUnsavedReadinessInputs}
        />
      ) : null}
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
                  Delete this workflow and its automations. This action cannot
                  be undone.
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

function hasUnsavedConnectorReadinessInputs(
  detail: ZeroWorkflowDetailResponse,
  metadataPatch: {
    readonly workflowId: string;
    readonly displayName?: string;
    readonly name?: string;
    readonly description?: string;
  } | null,
  fileDraft: {
    readonly workflowId: string;
    readonly filePath: string | null;
    readonly sourceContent: string;
    readonly content: string;
  } | null,
): boolean {
  const metadataDefaults = workflowMetadataDefaults(detail);
  const metadataValues =
    metadataPatch?.workflowId === detail.id
      ? { ...metadataDefaults, ...metadataPatch }
      : metadataDefaults;
  const metadataDirty =
    metadataValues.name !== metadataDefaults.name ||
    metadataValues.description !== metadataDefaults.description;
  const instruction = detail.instruction ?? "";
  const instructionDirty =
    fileDraft?.workflowId === detail.id &&
    fileDraft.filePath === null &&
    fileDraft.sourceContent === instruction &&
    fileDraft.content !== instruction;
  return metadataDirty || instructionDirty;
}

const CONNECTOR_READINESS_STATUS_GROUP: Readonly<
  Record<ZeroWorkflowConnectorReadinessEntry["status"], number>
> = Object.freeze({
  "reconnect-required": 0,
  "scope-mismatch": 0,
  "not-connected": 0,
  "not-enabled-for-agent": 0,
  unavailable: 1,
  connected: 2,
});

function sortConnectorReadinessEntries(
  entries: readonly ZeroWorkflowConnectorReadinessEntry[],
): ZeroWorkflowConnectorReadinessEntry[] {
  return [...entries].sort((left, right) => {
    const groupOrder =
      CONNECTOR_READINESS_STATUS_GROUP[left.status] -
      CONNECTOR_READINESS_STATUS_GROUP[right.status];
    if (groupOrder !== 0) {
      return groupOrder;
    }
    return left.label.localeCompare(right.label);
  });
}

function connectorReadinessStatus(
  status: ZeroWorkflowConnectorReadinessEntry["status"],
): {
  readonly label: string;
  readonly dotClassName: string;
  readonly textClassName: string;
} {
  switch (status) {
    case "reconnect-required": {
      return {
        label: "Reconnect required",
        dotClassName: "bg-amber-500",
        textClassName: "text-amber-600 dark:text-amber-400",
      };
    }
    case "scope-mismatch": {
      return {
        label: "Update permissions",
        dotClassName: "bg-amber-500",
        textClassName: "text-amber-600 dark:text-amber-400",
      };
    }
    case "not-connected": {
      return {
        label: "Not connected",
        dotClassName: "bg-amber-500",
        textClassName: "text-amber-600 dark:text-amber-400",
      };
    }
    case "not-enabled-for-agent": {
      return {
        label: "Not enabled for this agent",
        dotClassName: "bg-amber-500",
        textClassName: "text-amber-600 dark:text-amber-400",
      };
    }
    case "unavailable": {
      return {
        label: "Currently unavailable",
        dotClassName: "bg-gray-400",
        textClassName: "text-muted-foreground",
      };
    }
    case "connected": {
      return {
        label: "Connected",
        dotClassName: "bg-emerald-500",
        textClassName: "text-emerald-600 dark:text-emerald-400",
      };
    }
  }
}

function connectorReadinessAction(
  entry: ZeroWorkflowConnectorReadinessEntry,
  agentId: string,
): { readonly label: string; readonly href: string } | null {
  const query = new URLSearchParams({ agentId }).toString();
  switch (entry.status) {
    case "reconnect-required": {
      return {
        label: "Reconnect",
        href: `${generateRouterPath(ROUTES.directedConnect, {
          type: entry.connectorRef,
        })}?${query}`,
      };
    }
    case "scope-mismatch": {
      return {
        label: "Review permissions",
        href: `${generateRouterPath(ROUTES.directedConnect, {
          type: entry.connectorRef,
        })}?${query}`,
      };
    }
    case "not-connected": {
      return {
        label: "Connect",
        href: `${generateRouterPath(ROUTES.directedConnect, {
          type: entry.connectorRef,
        })}?${query}`,
      };
    }
    case "not-enabled-for-agent": {
      return {
        label: "Enable for agent",
        href: `${generateRouterPath(ROUTES.directedAuthorize, {
          type: entry.connectorRef,
        })}?${query}`,
      };
    }
    case "connected":
    case "unavailable": {
      return null;
    }
  }
}

function connectorReadinessErrorMessage(
  errorKind: "input-too-long" | "timeout" | "retry",
): string {
  switch (errorKind) {
    case "input-too-long": {
      return "This workflow is too long to check. Keep the name, description, and instructions within 100,000 characters.";
    }
    case "timeout": {
      return "The connector check timed out. Try again.";
    }
    case "retry": {
      return "We couldn't check connectors. Try again.";
    }
  }
}

function WorkflowConnectorReadiness({
  detail,
  hasUnsavedInputs,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
  readonly hasUnsavedInputs: boolean;
}) {
  const pageSignal = useGet(pageSignal$);
  const readinessState = useGet(workflowConnectorReadiness$);
  const [, checkReadiness] = useLoadableSet(checkWorkflowConnectorReadiness$);
  const currentState =
    readinessState?.workflowId === detail.id ? readinessState : null;
  const checking = currentState?.status === "pending";
  const failed = currentState?.status === "error";
  const errorMessage =
    currentState?.status === "error"
      ? connectorReadinessErrorMessage(currentState.errorKind)
      : null;
  const response =
    currentState?.status === "success" ? currentState.response : null;
  const entries = response
    ? sortConnectorReadinessEntries(response.connectors)
    : null;
  const checkLabel = checking
    ? "Checking..."
    : response || failed
      ? "Check again"
      : "Check connectors";

  return (
    <section
      className="zero-card overflow-hidden"
      aria-label="Connector readiness"
    >
      <div className="p-4 sm:p-5">
        <InlineSettingsRow
          label="Connector readiness"
          description="See which built-in connectors this workflow may need and whether they're ready."
          alignControls="center"
        >
          <div className="flex w-full flex-col items-start gap-2 sm:items-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="zero-btn-morandi h-9 gap-2 rounded-lg"
              disabled={checking || hasUnsavedInputs}
              onClick={() => {
                detach(
                  checkReadiness(detail.id, pageSignal),
                  Reason.DomCallback,
                  "check workflow connector readiness",
                );
              }}
            >
              {checking ? (
                <IconLoader2 size={14} className="animate-spin" />
              ) : (
                <IconPlugConnected size={14} stroke={1.5} />
              )}
              {checkLabel}
            </Button>
            {hasUnsavedInputs ? (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Save your changes before checking connectors.
              </p>
            ) : null}
          </div>
        </InlineSettingsRow>
      </div>
      {errorMessage ? (
        <div
          role="alert"
          className="flex items-start gap-2 border-t border-border/50 px-4 py-3 text-sm text-destructive sm:px-5"
        >
          <IconAlertTriangle
            size={16}
            stroke={1.5}
            className="mt-0.5 shrink-0"
          />
          <p>{errorMessage}</p>
        </div>
      ) : null}
      {entries ? (
        entries.length > 0 ? (
          <ul
            className="divide-y divide-border/50 border-t border-border/50"
            aria-live="polite"
          >
            {entries.map((entry) => {
              return (
                <WorkflowConnectorReadinessRow
                  key={entry.connectorRef}
                  entry={entry}
                  agentId={detail.agentId}
                />
              );
            })}
          </ul>
        ) : (
          <div
            className="flex items-center gap-2 border-t border-border/50 px-4 py-4 text-sm text-muted-foreground sm:px-5"
            aria-live="polite"
          >
            <IconCircleCheck
              size={16}
              stroke={1.5}
              className="shrink-0 text-emerald-500"
            />
            No required connectors detected
          </div>
        )
      ) : null}
    </section>
  );
}

function WorkflowConnectorReadinessRow({
  entry,
  agentId,
}: {
  readonly entry: ZeroWorkflowConnectorReadinessEntry;
  readonly agentId: string;
}) {
  const status = connectorReadinessStatus(entry.status);
  const action = connectorReadinessAction(entry, agentId);

  return (
    <li className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:gap-4 sm:px-5">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-50">
          <ConnectorIcon icon={entry.icon} size={18} />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">
            {entry.label}
          </p>
          <p className="mt-1 text-xs leading-snug text-muted-foreground">
            {entry.reason}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-between gap-3 pl-11 sm:justify-end sm:pl-0">
        <span
          className={cn(
            "flex items-center gap-2 whitespace-nowrap text-xs",
            status.textClassName,
          )}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              status.dotClassName,
            )}
            aria-hidden="true"
          />
          {status.label}
        </span>
        {action ? (
          <Button
            asChild
            variant="outline"
            size="sm"
            className="zero-btn-morandi h-8 gap-1.5 rounded-lg"
          >
            <a
              href={action.href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${action.label} ${entry.label}`}
            >
              {action.label}
              <IconExternalLink size={13} stroke={1.5} />
            </a>
          </Button>
        ) : null}
      </div>
    </li>
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
  const ownerAgentLabel = agentLabel(detail);

  return (
    <div className="p-4 sm:p-5">
      <InlineSettingsRow
        label="Agent"
        description="This workflow belongs to this agent."
        wideControls
      >
        <div className="flex h-9 w-full items-center rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-gray-50 px-3 text-sm text-muted-foreground">
          <span className="truncate" title={ownerAgentLabel}>
            {ownerAgentLabel}
          </span>
        </div>
      </InlineSettingsRow>
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
    detail.canManage && patch?.workflowId === detail.id
      ? { ...defaults, ...patch }
      : defaults;
  const dirty =
    values.displayName !== defaults.displayName ||
    values.name !== defaults.name ||
    values.description !== defaults.description;
  const patchValues = (patch: Partial<WorkflowMetadataValues>) => {
    if (!detail.canManage || saving) {
      return;
    }
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
      {detail.canManage && dirty ? (
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

function WorkflowPublicToggle({
  detail,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
}) {
  const pageSignal = useGet(pageSignal$);
  const [changeLoadable, changeVisibility] = useLoadableSet(
    changeWorkflowVisibility$,
  );
  const demoteConfirmOpen = useGet(workflowDemoteConfirmOpen$);
  const setDemoteConfirmOpen = useSet(setWorkflowDemoteConfirmOpen$);
  const busy = changeLoadable.state === "loading";
  const isPublic = detail.visibility === "public";
  const statusLabel = isPublic ? "Public" : "Private";
  const publishBlocked =
    detail.visibility === "private" && detail.canManage && !detail.canPublish;
  const toggleAction: Parameters<typeof changeVisibility>[0]["action"] | null =
    isPublic
      ? detail.canManage
        ? "demote"
        : null
      : detail.canPublish
        ? "publish"
        : null;
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
          aria-checked={isPublic}
          disabled={busy || !toggleAction}
          className={cn(
            "relative h-5 w-9 shrink-0 rounded-full transition-colors",
            isPublic ? "bg-primary/70" : "bg-muted",
            busy || !toggleAction ? "cursor-not-allowed opacity-60" : "",
          )}
          onClick={() => {
            if (!toggleAction) {
              return;
            }
            if (toggleAction === "demote") {
              setDemoteConfirmOpen(true);
              return;
            }
            submitVisibilityAction(toggleAction);
          }}
        >
          <span
            className={cn(
              "absolute left-0.5 top-0.5 size-4 rounded-full bg-background shadow-sm transition-transform",
              isPublic ? "translate-x-4" : "translate-x-0",
            )}
          />
        </button>
      </div>
      {publishBlocked ? (
        <p className="text-xs leading-5 text-muted-foreground">
          Publishing a workflow under an agent you do not own requires org admin
          permissions.
        </p>
      ) : null}
      <Dialog open={demoteConfirmOpen} onOpenChange={setDemoteConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Make this workflow private?</DialogTitle>
            <DialogDescription>
              This is a dangerous operation. While this workflow is private,
              automations other members built on it stop running.
            </DialogDescription>
          </DialogHeader>
          <Alert variant="destructive">
            <IconAlertTriangle size={16} stroke={1.5} />
            <AlertTitle>Automations will stop</AlertTitle>
            <AlertDescription>
              {workflowTitle(detail)} will be hidden from other members and
              their automations will stop.
            </AlertDescription>
          </Alert>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setDemoteConfirmOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setDemoteConfirmOpen(false);
                submitVisibilityAction("demote");
              }}
            >
              {busy ? <IconLoader2 size={14} className="animate-spin" /> : null}
              Make private
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface WorkflowCopyAgent {
  readonly id: string;
  readonly displayName: string | null;
}

function workflowCopyRemovalDescription({
  enabledSourceAutomationCount,
  sourceAgentName,
}: {
  readonly enabledSourceAutomationCount: number;
  readonly sourceAgentName: string;
}): string {
  if (enabledSourceAutomationCount === 0) {
    return `This workflow is deleted from ${sourceAgentName}.`;
  }
  return `${enabledSourceAutomationCount} ${
    enabledSourceAutomationCount === 1 ? "automation is" : "automations are"
  } paused on ${sourceAgentName} and this workflow is deleted.`;
}

function WorkflowCopyForm({
  agents,
  agentsLoaded,
  form,
  onChange,
  sourceAgentName,
  enabledSourceAutomationCount,
}: {
  readonly agents: readonly WorkflowCopyAgent[];
  readonly agentsLoaded: boolean;
  readonly form: WorkflowCopyFormState;
  readonly onChange: (form: WorkflowCopyFormState) => void;
  readonly sourceAgentName: string;
  readonly enabledSourceAutomationCount: number;
}) {
  const noAgents = agentsLoaded && agents.length === 0;

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <span className="text-sm font-medium text-foreground">Copy to</span>
        {noAgents ? (
          <p className="text-sm text-muted-foreground">No other agents yet</p>
        ) : (
          <Select
            value={form.selectedAgentId ?? undefined}
            disabled={!agentsLoaded}
            onValueChange={(value) => {
              onChange({ ...form, selectedAgentId: value });
            }}
          >
            <SelectTrigger className="h-9 w-full" aria-label="Copy to">
              <SelectValue placeholder="Choose an agent" />
            </SelectTrigger>
            <SelectContent>
              {agents.map((agent) => {
                return (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.displayName ?? agent.id}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        )}
      </div>
      <label className="flex items-start gap-2">
        <Checkbox
          checked={form.removeOriginal}
          className="mt-0.5"
          onCheckedChange={(checked) => {
            onChange({ ...form, removeOriginal: checked === true });
          }}
        />
        <span className="text-sm text-foreground">
          Remove the original from {sourceAgentName} after copying
        </span>
      </label>
      {form.removeOriginal ? (
        <Alert variant="destructive">
          <IconAlertTriangle size={16} stroke={1.5} />
          <AlertTitle>This deletes the original</AlertTitle>
          <AlertDescription>
            {workflowCopyRemovalDescription({
              enabledSourceAutomationCount,
              sourceAgentName,
            })}
          </AlertDescription>
        </Alert>
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
  const pageSignal = useGet(pageSignal$);
  const navigate = useSet(detachedNavigateTo$);
  const form = useGet(workflowCopyForm$);
  const setForm = useSet(setWorkflowCopyForm$);
  const [copyLoadable, copyWorkflow] = useLoadableSet(copyWorkflow$);
  const [pauseLoadable, pauseWorkflowAutomations] = useLoadableSet(
    pauseWorkflowAutomations$,
  );
  const [deleteLoadable, deleteWorkflow] = useLoadableSet(deleteWorkflow$);
  const agentsLoadable = useLoadable(agents$);
  const agentsLoaded = agentsLoadable.state === "hasData";
  const agents = agentsLoaded
    ? agentsLoadable.data.filter((agent) => {
        return agent.id !== detail.agentId;
      })
    : [];
  const submitting =
    copyLoadable.state === "loading" ||
    pauseLoadable.state === "loading" ||
    deleteLoadable.state === "loading";
  const sourceAgentName = agentLabel(detail);
  const enabledSourceAutomationIds = detail.automations
    .filter((automation) => {
      return automation.enabled;
    })
    .map((automation) => {
      return automation.id;
    });
  const selectedAgent = agents.find((agent) => {
    return agent.id === form.selectedAgentId;
  });
  const agentName =
    selectedAgent?.displayName ?? form.selectedAgentId ?? "the agent";

  const submit = () => {
    const toAgentId = form.selectedAgentId;
    if (!toAgentId) {
      return;
    }
    const removeOriginal = form.removeOriginal;
    detach(
      (async () => {
        const copied = await copyWorkflow(
          { workflowId: detail.id, toAgentId },
          pageSignal,
        );
        if (removeOriginal) {
          if (enabledSourceAutomationIds.length > 0) {
            await pauseWorkflowAutomations(
              enabledSourceAutomationIds,
              pageSignal,
            );
          }
          await deleteWorkflow(detail.id, pageSignal);
        }
        onOpenChange(false);
        if (removeOriginal) {
          navigate(ROUTES.workflowDetailAutomations, {
            pathParams: { workflowId: copied.id },
          });
          toast.success(`Moved to ${agentName}`, {
            description: `Original removed from ${sourceAgentName}.`,
          });
          return;
        }
        toast.success(`Copied to ${agentName}`, {
          description: "A private copy is ready.",
          action: {
            label: "View",
            onClick: () => {
              navigate(ROUTES.workflowDetailAutomations, {
                pathParams: { workflowId: copied.id },
              });
            },
          },
        });
      })(),
      Reason.DomCallback,
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Copy workflow</DialogTitle>
          <DialogDescription>
            Copy this workflow to another agent as a new private workflow.
          </DialogDescription>
        </DialogHeader>
        <WorkflowCopyForm
          agents={agents}
          agentsLoaded={agentsLoaded}
          form={form}
          onChange={setForm}
          sourceAgentName={sourceAgentName}
          enabledSourceAutomationCount={enabledSourceAutomationIds.length}
        />
        <WorkflowCopyDialogFooter
          submitting={submitting}
          removeOriginal={form.removeOriginal}
          disabled={!form.selectedAgentId || submitting || agents.length === 0}
          onCancel={() => {
            onOpenChange(false);
          }}
          onSubmit={submit}
        />
      </DialogContent>
    </Dialog>
  );
}

function WorkflowCopyDialogFooter({
  submitting,
  removeOriginal,
  disabled,
  onCancel,
  onSubmit,
}: {
  readonly submitting: boolean;
  readonly removeOriginal: boolean;
  readonly disabled: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: () => void;
}) {
  return (
    <DialogFooter>
      <Button
        type="button"
        variant="outline"
        disabled={submitting}
        onClick={onCancel}
      >
        Cancel
      </Button>
      <Button type="button" disabled={disabled} onClick={onSubmit}>
        {submitting ? <IconLoader2 size={14} className="animate-spin" /> : null}
        {removeOriginal ? "Copy and remove" : "Copy workflow"}
      </Button>
    </DialogFooter>
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
            every automation bound to it, including automations other users
            created.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {workflowTitle(detail)} and all bound automations will be deleted.
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
                  navigate(ROUTES.workflows);
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
      <DropdownMenuContent align="end" className="w-80">
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
  const draft = detail.canManage && draftMatches ? draftState.content : null;
  const content = draft ?? sourceContent;
  const dirty = draft !== null && draft !== sourceContent;
  const markdown =
    selectedFilePath === null || isMarkdownPath(selectedFilePath);
  const setDraft = (nextContent: string) => {
    if (!detail.canManage || saving) {
      return;
    }
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
      {detail.canManage && dirty ? (
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
    schedule.timezone || AUTOMATION_TIMEZONE,
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
    AUTOMATION_TIMEZONE,
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
  automation: ZeroWorkflowAutomationSummary,
  displayTimezone: string,
): string {
  if (automation.kind !== "schedule") {
    return workflowAutomationTitle(automation);
  }
  const schedule = automation.schedule;
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
    return `${schedule.cronExpression} (${AUTOMATION_TIMEZONE})`;
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
    : automation.scheduleSummary;
}

function buildAutomationSchedule(
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
      ? { type: "cron", cronExpression, timezone: AUTOMATION_TIMEZONE }
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
        timezone: AUTOMATION_TIMEZONE,
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

function gmailMatchConditions(
  config?: GmailNewMessageEventConfig,
): GmailMatchCondition[] {
  const conditions: GmailMatchCondition[] = [];
  for (const { field } of GMAIL_TEXT_FIELDS) {
    for (const { operator } of GMAIL_TEXT_OPERATORS) {
      const value = config?.match?.[field]?.[operator];
      if (value) {
        conditions.push({ field, operator, value });
      }
    }
  }
  return conditions.length > 0
    ? conditions
    : [{ field: "from", operator: "contains", value: "" }];
}

function nextGmailMatchCondition(
  conditions: readonly GmailMatchCondition[],
): GmailMatchCondition | null {
  for (const { operator } of GMAIL_TEXT_OPERATORS) {
    for (const { field } of GMAIL_TEXT_FIELDS) {
      const used = conditions.some((condition) => {
        return condition.field === field && condition.operator === operator;
      });
      if (!used) {
        return { field, operator, value: "" };
      }
    }
  }
  return null;
}

function gmailTextFieldOption(
  value: string,
): (typeof GMAIL_TEXT_FIELDS)[number] {
  const option = GMAIL_TEXT_FIELDS.find((candidate) => {
    return candidate.field === value;
  });
  if (!option) {
    throw new Error(`Unknown Gmail text field: ${value}`);
  }
  return option;
}

function gmailTextOperatorOption(
  value: string,
): (typeof GMAIL_TEXT_OPERATORS)[number] {
  const option = GMAIL_TEXT_OPERATORS.find((candidate) => {
    return candidate.operator === value;
  });
  if (!option) {
    throw new Error(`Unknown Gmail text operator: ${value}`);
  }
  return option;
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

type GoogleCalendarAutomationEventType =
  | "google-calendar-event-created"
  | "google-calendar-event-updated"
  | "google-calendar-event-cancelled";

function googleCalendarIdFromForm(form: FormData): string {
  return formTextValue(form, "calendarId") ?? "primary";
}

function githubSubjectFilterValue(
  value: FormDataEntryValue | null,
  fallback: GithubLabelAppliedSubjectFilter,
): GithubLabelAppliedSubjectFilter {
  if (value === "both" || value === "issues" || value === "pull_requests") {
    return value;
  }
  return fallback;
}

function githubActorFilterValue(
  value: FormDataEntryValue | null,
  fallback: "me" | "anyone",
): "me" | "anyone" {
  if (value === "me" || value === "anyone") {
    return value;
  }
  return fallback;
}

function buildGithubLabelAppliedEventConfig(
  form: FormData,
  baseConfig?: GithubLabelAppliedEventConfig,
): GithubLabelAppliedEventConfig | null {
  const labelName = formTextValue(form, "labelName") ?? baseConfig?.labelName;
  if (!labelName) {
    return null;
  }
  return {
    provider: "github",
    event: "label_applied",
    labelName,
    filters: {
      subject: githubSubjectFilterValue(
        form.get("subject"),
        baseConfig?.filters.subject ?? "both",
      ),
      actor: {
        type: githubActorFilterValue(
          form.get("actor"),
          baseConfig?.filters.actor.type ?? "me",
        ),
      },
    },
  };
}

function githubWorkflowRunFilterValues(
  form: FormData,
  name: string,
): string[] | undefined {
  const value = formTextValue(form, name);
  if (!value) {
    return undefined;
  }
  const values = Array.from(
    new Set(
      value
        .split(/[,\n]/u)
        .map((part) => {
          return part.trim();
        })
        .filter(Boolean),
    ),
  );
  return values.length > 0 ? values : undefined;
}

function githubWorkflowRunConclusions(
  form: FormData,
): GithubWorkflowRunConclusion[] | undefined {
  const values = form
    .getAll("conclusions")
    .filter((value): value is GithubWorkflowRunConclusion => {
      return (
        typeof value === "string" &&
        GITHUB_WORKFLOW_RUN_CONCLUSION_OPTIONS.some((option) => {
          return option.value === value;
        })
      );
    });
  return values.length > 0 ? values : undefined;
}

function buildGithubWorkflowRunCompletedEventConfig(
  form: FormData,
): GithubWorkflowRunCompletedEventConfig {
  return {
    provider: "github",
    event: "workflow_run_completed",
    filters: {
      repositories: githubWorkflowRunFilterValues(form, "repositories"),
      workflows: githubWorkflowRunFilterValues(form, "workflows"),
      conclusions: githubWorkflowRunConclusions(form),
      branches: githubWorkflowRunFilterValues(form, "branches"),
      events: githubWorkflowRunFilterValues(form, "events"),
      actors: githubWorkflowRunFilterValues(form, "actors"),
    },
  };
}

type GithubWebhookAutomationEventType =
  | "github-workflow-job-completed"
  | "github-pull-request-review-submitted"
  | "github-deployment-status-created"
  | "github-issue-comment-created";

type GithubWebhookAutomationEventConfig =
  | GithubWorkflowJobCompletedEventConfig
  | GithubPullRequestReviewSubmittedEventConfig
  | GithubDeploymentStatusCreatedEventConfig
  | GithubIssueCommentCreatedEventConfig;

function checkedGithubValues<T extends string>(
  form: FormData,
  name: string,
  options: readonly { readonly value: T }[],
): T[] | undefined {
  const values = form.getAll(name).filter((value): value is T => {
    return (
      typeof value === "string" &&
      options.some((option) => {
        return option.value === value;
      })
    );
  });
  return values.length > 0 ? values : undefined;
}

function buildGithubWebhookEventConfig(
  eventType: GithubWebhookAutomationEventType,
  form: FormData,
): GithubWebhookAutomationEventConfig {
  if (eventType === "github-workflow-job-completed") {
    return {
      provider: "github",
      event: "workflow_job_completed",
      filters: {
        repositories: githubWorkflowRunFilterValues(form, "repositories"),
        workflows: githubWorkflowRunFilterValues(form, "workflows"),
        jobs: githubWorkflowRunFilterValues(form, "jobs"),
        conclusions: githubWorkflowRunConclusions(form),
        branches: githubWorkflowRunFilterValues(form, "branches"),
        runnerLabels: githubWorkflowRunFilterValues(form, "runnerLabels"),
        runnerGroups: githubWorkflowRunFilterValues(form, "runnerGroups"),
      },
    };
  }
  if (eventType === "github-pull-request-review-submitted") {
    return {
      provider: "github",
      event: "pull_request_review_submitted",
      filters: {
        repositories: githubWorkflowRunFilterValues(form, "repositories"),
        reviewStates: checkedGithubValues(
          form,
          "reviewStates",
          GITHUB_REVIEW_STATE_OPTIONS,
        ),
        baseBranches: githubWorkflowRunFilterValues(form, "baseBranches"),
        headBranches: githubWorkflowRunFilterValues(form, "headBranches"),
        trustedAuthors: githubWorkflowRunFilterValues(form, "trustedAuthors"),
      },
    };
  }
  if (eventType === "github-deployment-status-created") {
    const productionEnvironment = form.get("productionEnvironment");
    return {
      provider: "github",
      event: "deployment_status_created",
      filters: {
        repositories: githubWorkflowRunFilterValues(form, "repositories"),
        environments: githubWorkflowRunFilterValues(form, "environments"),
        states: checkedGithubValues(
          form,
          "deploymentStates",
          GITHUB_DEPLOYMENT_STATE_OPTIONS,
        ),
        refs: githubWorkflowRunFilterValues(form, "refs"),
        productionEnvironment:
          productionEnvironment === "true"
            ? true
            : productionEnvironment === "false"
              ? false
              : undefined,
        creators: githubWorkflowRunFilterValues(form, "creators"),
        apps: githubWorkflowRunFilterValues(form, "apps"),
      },
    };
  }
  return {
    provider: "github",
    event: "issue_comment_created",
    filters: {
      repositories: githubWorkflowRunFilterValues(form, "repositories"),
      subject: githubSubjectFilterValue(form.get("subject"), "both"),
      trustedAuthors: githubWorkflowRunFilterValues(form, "trustedAuthors"),
      commentPrefixes: githubWorkflowRunFilterValues(form, "commentPrefixes"),
    },
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

function workflowAutomationTitle(
  automation: ZeroWorkflowAutomationSummary,
): string {
  if (automation.kind === "schedule") {
    return automation.scheduleSummary;
  }
  if (automation.eventType === "gmail-new-message") {
    return "Gmail new message";
  }
  if (automation.eventType === "gmail-label-applied") {
    return "Gmail label applied";
  }
  if (automation.eventType === "github-label-applied") {
    return "GitHub label applied";
  }
  if (automation.eventType === "github-workflow-job-completed") {
    return "GitHub workflow job completed";
  }
  if (automation.eventType === "github-pull-request-review-submitted") {
    return "GitHub pull request review submitted";
  }
  if (automation.eventType === "github-deployment-status-created") {
    return "GitHub deployment status created";
  }
  if (automation.eventType === "github-issue-comment-created") {
    return "GitHub issue comment created";
  }
  if (automation.eventType === "github-workflow-run-completed") {
    return "GitHub workflow completed";
  }
  if (automation.eventType === "google-calendar-event-created") {
    return "Google Calendar event created";
  }
  if (automation.eventType === "google-calendar-event-updated") {
    return "Google Calendar event updated";
  }
  if (automation.eventType === "google-calendar-event-cancelled") {
    return "Google Calendar event cancelled";
  }
  if (automation.eventType === "google-meet-transcript-generated") {
    return "Google Meet transcript ready";
  }
  if (automation.eventType === "notion-child-page-created") {
    return "New Notion child page";
  }
  if (automation.eventType === "notion-database-item-created") {
    return "New Notion database item";
  }
  if (automation.eventType === "notion-page-content-updated") {
    return "Notion page content updated";
  }
  return "Webhook";
}

function githubWorkflowRunAutomationSummary(
  config: GithubWorkflowRunCompletedEventConfig,
): string {
  const filters = config.filters;
  return [
    filters.repositories
      ? `Repositories ${filters.repositories.join(", ")}`
      : "Any repository",
    filters.workflows
      ? `Workflows ${filters.workflows.join(", ")}`
      : "Any workflow",
    filters.conclusions
      ? `Conclusions ${filters.conclusions.join(", ")}`
      : "Any conclusion",
  ].join(" · ");
}

function githubWorkflowJobAutomationSummary(
  config: GithubWorkflowJobCompletedEventConfig,
): string {
  const filters = config.filters;
  return [
    filters.repositories?.join(", ") ?? "Any repository",
    filters.jobs ? `Jobs ${filters.jobs.join(", ")}` : "Any job",
    filters.conclusions?.join(", ") ?? "Any conclusion",
  ].join(" · ");
}

function githubReviewAutomationSummary(
  config: GithubPullRequestReviewSubmittedEventConfig,
): string {
  const filters = config.filters;
  return [
    filters.repositories?.join(", ") ?? "Any repository",
    filters.reviewStates?.join(", ") ?? "Any review state",
    filters.trustedAuthors
      ? `Authors ${filters.trustedAuthors.join(", ")}`
      : "Any author",
  ].join(" · ");
}

function githubDeploymentAutomationSummary(
  config: GithubDeploymentStatusCreatedEventConfig,
): string {
  const filters = config.filters;
  return [
    filters.repositories?.join(", ") ?? "Any repository",
    filters.environments?.join(", ") ?? "Any environment",
    filters.states?.join(", ") ?? "Any state",
  ].join(" · ");
}

function githubCommentAutomationSummary(
  config: GithubIssueCommentCreatedEventConfig,
): string {
  const filters = config.filters;
  const subject =
    GITHUB_SUBJECT_OPTIONS.find((option) => {
      return option.value === filters.subject;
    })?.label ?? "Issues and pull requests";
  return [
    filters.repositories?.join(", ") ?? "Any repository",
    subject,
    filters.trustedAuthors
      ? `Authors ${filters.trustedAuthors.join(", ")}`
      : "Any author",
  ].join(" · ");
}

function githubWorkflowAutomationSummary(
  automation: Extract<
    ZeroWorkflowAutomationSummary,
    { readonly kind: "event" }
  >,
): string | null {
  switch (automation.eventType) {
    case "github-label-applied": {
      const subject =
        GITHUB_SUBJECT_OPTIONS.find((option) => {
          return option.value === automation.eventConfig.filters.subject;
        })?.label ?? "Issues and pull requests";
      const actor =
        automation.eventConfig.filters.actor.type === "me" ? "me" : "anyone";
      return `Label ${quote(automation.eventConfig.labelName)} · ${subject} · Actor ${actor}`;
    }
    case "github-workflow-run-completed": {
      return githubWorkflowRunAutomationSummary(automation.eventConfig);
    }
    case "github-workflow-job-completed": {
      return githubWorkflowJobAutomationSummary(automation.eventConfig);
    }
    case "github-pull-request-review-submitted": {
      return githubReviewAutomationSummary(automation.eventConfig);
    }
    case "github-deployment-status-created": {
      return githubDeploymentAutomationSummary(automation.eventConfig);
    }
    case "github-issue-comment-created": {
      return githubCommentAutomationSummary(automation.eventConfig);
    }
    default: {
      return null;
    }
  }
}

function workflowAutomationSummary(
  automation: ZeroWorkflowAutomationSummary,
): string | null {
  if (automation.kind !== "event") {
    return null;
  }
  if (automation.eventType === "gmail-new-message") {
    return formatGmailMatchSummary(automation.eventConfig);
  }
  if (automation.eventType === "gmail-label-applied") {
    return `Label ${quote(automation.eventConfig.labelName)}`;
  }
  const githubSummary = githubWorkflowAutomationSummary(automation);
  if (githubSummary) {
    return githubSummary;
  }
  if (
    automation.eventType === "google-calendar-event-created" ||
    automation.eventType === "google-calendar-event-updated" ||
    automation.eventType === "google-calendar-event-cancelled"
  ) {
    return `Calendar ${quote(automation.eventConfig.calendarId)}`;
  }
  if (automation.eventType === "google-meet-transcript-generated") {
    return "Meetings you organize";
  }
  if (automation.eventType === "notion-child-page-created") {
    const title = automation.eventConfig.parentPage.title;
    return title ? `Parent page ${quote(title)}` : "Configured parent page";
  }
  if (automation.eventType === "notion-database-item-created") {
    const title = automation.eventConfig.dataSource.title;
    return title ? `Database ${quote(title)}` : "Configured database";
  }
  if (automation.eventType === "notion-page-content-updated") {
    if (automation.eventConfig.scope.type === "page") {
      const title = automation.eventConfig.scope.page.title;
      return title ? `Page ${quote(title)}` : "Configured page";
    }
    const title = automation.eventConfig.scope.dataSource.title;
    return title ? `Database ${quote(title)}` : "Configured database";
  }
  return null;
}

type AutomationCreateDialogKind =
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
  | "webhook";

type AutomationCategoryKey =
  | "schedule"
  | "email"
  | "calendar"
  | "notion"
  | "integrations";

type AutomationCreateOption = {
  readonly kind: AutomationCreateDialogKind;
  readonly title: string;
  readonly description: string;
  readonly icon: typeof IconClock;
  readonly badge?: string;
};

type AutomationCreateCategory = {
  readonly key: AutomationCategoryKey;
  readonly label: string;
  readonly icon: typeof IconClock;
  readonly options: readonly AutomationCreateOption[];
};

function buildIntegrationAutomationOptions({
  githubLabelAutomationsEnabled,
  githubWebhookAutomationsEnabled,
  webhookTierEligible,
}: {
  readonly githubLabelAutomationsEnabled: boolean;
  readonly githubWebhookAutomationsEnabled: boolean;
  readonly webhookTierEligible: boolean;
}): AutomationCreateOption[] {
  const integrationOptions: AutomationCreateOption[] = [];
  if (githubLabelAutomationsEnabled) {
    integrationOptions.push({
      kind: "github-label",
      title: "GitHub label applied",
      description: "Run when an issue or pull request gets a label.",
      icon: IconBrandGithub,
    });
  }
  integrationOptions.push({
    kind: "github-workflow-run",
    title: "GitHub workflow completed",
    description: "Run when a matching Actions workflow run completes.",
    icon: IconBrandGithub,
  });
  if (githubWebhookAutomationsEnabled) {
    integrationOptions.push(
      {
        kind: "github-workflow-job",
        title: "GitHub workflow job completed",
        description: "Run when a matching Actions job completes.",
        icon: IconBrandGithub,
      },
      {
        kind: "github-pull-request-review",
        title: "GitHub pull request review submitted",
        description: "Run when a matching review is submitted.",
        icon: IconBrandGithub,
      },
      {
        kind: "github-deployment-status",
        title: "GitHub deployment status created",
        description: "Run when a matching deployment status is created.",
        icon: IconBrandGithub,
      },
      {
        kind: "github-issue-comment",
        title: "GitHub issue comment created",
        description: "Run when a matching issue or PR comment is created.",
        icon: IconBrandGithub,
      },
    );
  }
  integrationOptions.push({
    kind: "webhook",
    title: "Webhook",
    description: "Run this workflow from a signed POST.",
    icon: IconLink,
    ...(webhookTierEligible ? {} : { badge: "Team" }),
  });
  return integrationOptions;
}

function buildNotionAutomationOptions(
  notionWorkflowAutomationsEnabled: boolean,
): AutomationCreateOption[] {
  if (!notionWorkflowAutomationsEnabled) {
    return [];
  }
  return [
    {
      kind: "notion-child-page",
      title: "New Notion child page",
      description: "Run when a direct child page is created.",
      icon: IconFilePlus,
    },
    {
      kind: "notion-database-item",
      title: "New Notion database item",
      description: "Run when a page is added to a Notion database.",
      icon: IconDatabasePlus,
    },
    {
      kind: "notion-page-content-updated",
      title: "Notion page content updated",
      description: "Run when a page or database item content changes.",
      icon: IconFilePencil,
    },
  ];
}

// Each category owns a single hue that colours only the card icon chip on the
// right; the category rail stays neutral and mirrors the app sidebar.
const AUTOMATION_CATEGORY_CHIP: Readonly<
  Record<AutomationCategoryKey, string>
> = Object.freeze({
  schedule: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  email: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  calendar: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  notion: "bg-gray-500/10 text-gray-700 dark:text-gray-300",
  integrations: "bg-amber-500/10 text-amber-600 dark:text-amber-500",
});

function buildAutomationCreateCategories({
  githubLabelAutomationsEnabled,
  githubWebhookAutomationsEnabled,
  googleCalendarAutomationsEnabled,
  googleMeetAutomationsEnabled,
  notionWorkflowAutomationsEnabled,
  webhookTierEligible,
}: {
  readonly githubLabelAutomationsEnabled: boolean;
  readonly githubWebhookAutomationsEnabled: boolean;
  readonly googleCalendarAutomationsEnabled: boolean;
  readonly googleMeetAutomationsEnabled: boolean;
  readonly notionWorkflowAutomationsEnabled: boolean;
  readonly webhookTierEligible: boolean;
}): readonly AutomationCreateCategory[] {
  const calendarOptions: AutomationCreateOption[] = [];
  if (googleCalendarAutomationsEnabled) {
    calendarOptions.push(
      {
        kind: "google-calendar-created",
        title: "Google Calendar event created",
        description: "Run when a calendar event is created.",
        icon: IconCalendarTime,
      },
      {
        kind: "google-calendar-updated",
        title: "Google Calendar event updated",
        description: "Run when a calendar event is updated.",
        icon: IconCalendarTime,
      },
      {
        kind: "google-calendar-cancelled",
        title: "Google Calendar event cancelled",
        description: "Run when a calendar event is cancelled.",
        icon: IconCalendarTime,
      },
    );
  }
  if (googleMeetAutomationsEnabled) {
    calendarOptions.push({
      kind: "google-meet-transcript-generated",
      title: "Google Meet transcript ready",
      description: "Run when Meet finishes generating a transcript.",
      icon: IconVideo,
    });
  }

  const integrationOptions = buildIntegrationAutomationOptions({
    githubLabelAutomationsEnabled,
    githubWebhookAutomationsEnabled,
    webhookTierEligible,
  });
  const notionOptions = buildNotionAutomationOptions(
    notionWorkflowAutomationsEnabled,
  );

  const categories: readonly AutomationCreateCategory[] = [
    {
      key: "schedule",
      label: "Schedule",
      icon: IconClock,
      options: [
        {
          kind: "interval",
          title: "Interval",
          description: "Run this workflow on a fixed interval.",
          icon: IconRepeat,
        },
        {
          kind: "scheduled",
          title: "Scheduled time",
          description: "Run this workflow from a time rule.",
          icon: IconClock,
        },
        {
          kind: "once",
          title: "One-time run",
          description: "Run this workflow once at a date and time.",
          icon: IconClock,
        },
      ],
    },
    {
      key: "email",
      label: "Email",
      icon: IconMail,
      options: [
        {
          kind: "gmail",
          title: "Gmail new message",
          description: "Run this workflow from matching email.",
          icon: IconMail,
        },
        {
          kind: "gmail-label",
          title: "Gmail label applied",
          description: "Run when a named Gmail label is applied.",
          icon: IconMail,
        },
      ],
    },
    {
      key: "calendar",
      label: "Calendar",
      icon: IconCalendarTime,
      options: calendarOptions,
    },
    {
      key: "notion",
      label: "Notion",
      icon: IconBrandNotion,
      options: notionOptions,
    },
    {
      key: "integrations",
      label: "Integrations",
      icon: IconLink,
      options: integrationOptions,
    },
  ];

  return categories.filter((category) => {
    return category.options.length > 0;
  });
}

function AutomationCreateCategoryButton({
  category,
  active,
  onSelect,
}: {
  readonly category: AutomationCreateCategory;
  readonly active: boolean;
  readonly onSelect: () => void;
}) {
  const Icon = category.icon;
  // Mirror the app sidebar nav row: neutral gray active state, plain icon,
  // h-8 rounded-lg row — no category colour on the rail.
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-8 w-full shrink-0 items-center gap-2 rounded-lg px-2 text-left text-sm leading-5 transition-colors duration-200",
        active
          ? "bg-gray-200 font-medium text-gray-900"
          : "text-sidebar-foreground hover:bg-gray-50",
      )}
    >
      <Icon size={16} stroke={1.5} className="shrink-0" />
      <span className="truncate">{category.label}</span>
    </button>
  );
}

function AutomationCreateOptionCard({
  option,
  accentChip,
  onSelect,
}: {
  readonly option: AutomationCreateOption;
  readonly accentChip: string;
  readonly onSelect: () => void;
}) {
  const Icon = option.icon;
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex min-h-[8rem] flex-col items-start gap-3.5 rounded-2xl border-[0.7px] border-[hsl(var(--gray-400))] bg-card p-5 text-left transition-colors hover:border-[hsl(var(--gray-500))] hover:bg-gray-50"
    >
      <span
        className={cn(
          "flex size-11 items-center justify-center rounded-xl",
          accentChip,
        )}
      >
        <Icon size={20} stroke={1.5} />
      </span>
      <span className="flex min-w-0 flex-col gap-1">
        <span className="text-sm font-semibold">{option.title}</span>
        {option.badge ? (
          <span className="mt-0.5 w-fit rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
            {option.badge}
          </span>
        ) : null}
        <span className="text-xs text-muted-foreground">
          {option.description}
        </span>
      </span>
    </button>
  );
}

function AutomationCreateMenu({
  onSelect,
  githubLabelAutomationsEnabled,
  githubWebhookAutomationsEnabled,
  googleCalendarAutomationsEnabled,
  googleMeetAutomationsEnabled,
  notionWorkflowAutomationsEnabled,
  webhookTierEligible,
}: {
  readonly onSelect: (kind: AutomationCreateDialogKind) => void;
  readonly githubLabelAutomationsEnabled: boolean;
  readonly githubWebhookAutomationsEnabled: boolean;
  readonly googleCalendarAutomationsEnabled: boolean;
  readonly googleMeetAutomationsEnabled: boolean;
  readonly notionWorkflowAutomationsEnabled: boolean;
  readonly webhookTierEligible: boolean;
}) {
  const open = useGet(workflowAutomationPickerOpen$);
  const setOpen = useSet(setWorkflowAutomationPickerOpen$);
  const activeKey = useGet(workflowAutomationPickerCategory$);
  const setActiveKey = useSet(setWorkflowAutomationPickerCategory$);
  const categories = buildAutomationCreateCategories({
    githubLabelAutomationsEnabled,
    githubWebhookAutomationsEnabled,
    googleCalendarAutomationsEnabled,
    googleMeetAutomationsEnabled,
    notionWorkflowAutomationsEnabled,
    webhookTierEligible,
  });
  const activeCategory =
    categories.find((category) => {
      return category.key === activeKey;
    }) ?? categories[0];
  const activeChip = activeCategory
    ? AUTOMATION_CATEGORY_CHIP[activeCategory.key]
    : "";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="zero-btn-morandi inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium"
        >
          <IconPlus size={14} stroke={1.5} />
          <span>Add automation</span>
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[880px]">
        <DialogHeader>
          <DialogTitle>Add automation</DialogTitle>
          <DialogDescription>
            Choose an automation to start this workflow.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-5 sm:min-h-[20rem] sm:flex-row sm:gap-7">
          <nav className="-ml-2 flex gap-1 overflow-x-auto pb-1 sm:w-44 sm:shrink-0 sm:flex-col sm:gap-1 sm:overflow-visible sm:border-r sm:border-border/60 sm:pb-0 sm:pr-4">
            {categories.map((category) => {
              return (
                <AutomationCreateCategoryButton
                  key={category.key}
                  category={category}
                  active={category.key === activeCategory?.key}
                  onSelect={() => {
                    setActiveKey(category.key);
                  }}
                />
              );
            })}
          </nav>
          <div className="grid min-w-0 flex-1 auto-rows-min grid-cols-1 content-start gap-4 sm:grid-cols-2">
            {activeCategory?.options.map((option) => {
              return (
                <AutomationCreateOptionCard
                  key={option.kind}
                  option={option}
                  accentChip={activeChip}
                  onSelect={() => {
                    onSelect(option.kind);
                    setOpen(false);
                  }}
                />
              );
            })}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function GoogleCalendarAutomationDialogs({
  workflowId,
  createDialog,
  setCreateDialog,
}: {
  readonly workflowId: string;
  readonly createDialog: AutomationCreateDialogKind | null;
  readonly setCreateDialog: (dialog: AutomationCreateDialogKind | null) => void;
}) {
  return (
    <>
      <CreateGoogleCalendarEventAutomationDialog
        workflowId={workflowId}
        eventType="google-calendar-event-created"
        open={createDialog === "google-calendar-created"}
        onOpenChange={(open) => {
          setCreateDialog(open ? "google-calendar-created" : null);
        }}
      />
      <CreateGoogleCalendarEventAutomationDialog
        workflowId={workflowId}
        eventType="google-calendar-event-updated"
        open={createDialog === "google-calendar-updated"}
        onOpenChange={(open) => {
          setCreateDialog(open ? "google-calendar-updated" : null);
        }}
      />
      <CreateGoogleCalendarEventAutomationDialog
        workflowId={workflowId}
        eventType="google-calendar-event-cancelled"
        open={createDialog === "google-calendar-cancelled"}
        onOpenChange={(open) => {
          setCreateDialog(open ? "google-calendar-cancelled" : null);
        }}
      />
    </>
  );
}

function CreateGoogleMeetTranscriptGeneratedAutomationDialog({
  workflowId,
  open,
  onOpenChange,
}: {
  readonly workflowId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [createLoadable, createGoogleMeetAutomation] = useLoadableSet(
    createWorkflowGoogleMeetTranscriptGeneratedAutomation$,
  );
  const creating = createLoadable.state === "loading";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Google Meet automation</DialogTitle>
          <DialogDescription>
            Run this workflow when Google Meet finishes generating a transcript
            for a meeting organized by the connected Google Meet account.
          </DialogDescription>
        </DialogHeader>
        <form
          aria-label="Add Google Meet transcript automation"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            detach(
              (async () => {
                await createGoogleMeetAutomation(
                  {
                    workflowId,
                    eventConfig: {
                      provider: "google-meet",
                      event: "transcript_generated",
                      scope: { type: "organizer_user" },
                    },
                  },
                  pageSignal,
                );
                onOpenChange(false);
              })(),
              Reason.DomCallback,
            );
          }}
        >
          <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            Transcription must be enabled for the meeting. If Meet does not
            create a transcript, this automation will not run.
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
              ) : (
                <IconVideo size={14} stroke={1.5} />
              )}
              Add Meet automation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AutomationsSection({
  detail,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
}) {
  const createDialog = useGet(workflowAutomationCreateDialog$);
  const setCreateDialog = useSet(setWorkflowAutomationCreateDialog$);
  const userLoadable = useLoadable(user$);
  const preferences = useLastResolved(userPreferences$);
  const currentUserId =
    userLoadable.state === "hasData" ? (userLoadable.data?.id ?? "") : "";
  const displayTimezone = preferences?.timezone ?? browserTimezone();
  const automations = detail.automations;

  return (
    <section className="mx-auto flex max-w-[900px] flex-col gap-3">
      <div className="flex flex-col gap-2">
        {automations.length > 0 ? (
          <div className="zero-card overflow-visible">
            {automations.map((automation, index) => {
              return (
                <AutomationRow
                  key={automation.id}
                  automation={automation}
                  canManage={automation.ownerUserId === currentUserId}
                  displayTimezone={displayTimezone}
                  showDivider={index < automations.length - 1}
                />
              );
            })}
          </div>
        ) : (
          <div className="zero-card flex min-h-[20rem] flex-col items-center justify-center px-6 text-center">
            <img
              src={emptyAutomationsImg}
              alt="No automations"
              className="h-24 w-24 object-contain opacity-80"
            />
            <p className="mt-3 text-sm font-medium text-foreground">
              No automations
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Add an automation to run this workflow whenever its automation
              fires.
            </p>
          </div>
        )}
      </div>
      <WorkflowAutomationCreateDialogs
        workflowId={detail.id}
        displayTimezone={displayTimezone}
        createDialog={createDialog}
        setCreateDialog={setCreateDialog}
      />
    </section>
  );
}

function WorkflowAutomationCreateDialogs({
  workflowId,
  displayTimezone,
  createDialog,
  setCreateDialog,
}: {
  readonly workflowId: string;
  readonly displayTimezone: string;
  readonly createDialog: WorkflowAutomationCreateDialog;
  readonly setCreateDialog: (dialog: WorkflowAutomationCreateDialog) => void;
}) {
  return (
    <>
      <CreateIntervalAutomationDialog
        workflowId={workflowId}
        open={createDialog === "interval"}
        onOpenChange={(open) => {
          setCreateDialog(open ? "interval" : null);
        }}
      />
      <CreateScheduledAutomationDialog
        workflowId={workflowId}
        displayTimezone={displayTimezone}
        open={createDialog === "scheduled"}
        onOpenChange={(open) => {
          setCreateDialog(open ? "scheduled" : null);
        }}
      />
      <CreateOnceAutomationDialog
        workflowId={workflowId}
        displayTimezone={displayTimezone}
        open={createDialog === "once"}
        onOpenChange={(open) => {
          setCreateDialog(open ? "once" : null);
        }}
      />
      <CreateGmailNewMessageAutomationDialog
        workflowId={workflowId}
        open={createDialog === "gmail"}
        onOpenChange={(open) => {
          setCreateDialog(open ? "gmail" : null);
        }}
      />
      <CreateGmailLabelAppliedAutomationDialog
        workflowId={workflowId}
        open={createDialog === "gmail-label"}
        onOpenChange={(open) => {
          setCreateDialog(open ? "gmail-label" : null);
        }}
      />
      <CreateGithubLabelAppliedAutomationDialog
        workflowId={workflowId}
        open={createDialog === "github-label"}
        onOpenChange={(open) => {
          setCreateDialog(open ? "github-label" : null);
        }}
      />
      <CreateGithubWorkflowRunCompletedAutomationDialog
        workflowId={workflowId}
        open={createDialog === "github-workflow-run"}
        onOpenChange={(open) => {
          setCreateDialog(open ? "github-workflow-run" : null);
        }}
      />
      <GithubWebhookAutomationCreateDialogs
        workflowId={workflowId}
        createDialog={createDialog}
        setCreateDialog={setCreateDialog}
      />
      <GoogleCalendarAutomationDialogs
        workflowId={workflowId}
        createDialog={createDialog}
        setCreateDialog={setCreateDialog}
      />
      <CreateGoogleMeetTranscriptGeneratedAutomationDialog
        workflowId={workflowId}
        open={createDialog === "google-meet-transcript-generated"}
        onOpenChange={(open) => {
          setCreateDialog(open ? "google-meet-transcript-generated" : null);
        }}
      />
      <CreateNotionChildPageAutomationDialog
        workflowId={workflowId}
        open={createDialog === "notion-child-page"}
        onOpenChange={(open) => {
          setCreateDialog(open ? "notion-child-page" : null);
        }}
      />
      <CreateNotionDatabaseItemAutomationDialog
        workflowId={workflowId}
        open={createDialog === "notion-database-item"}
        onOpenChange={(open) => {
          setCreateDialog(open ? "notion-database-item" : null);
        }}
      />
      <CreateNotionPageContentUpdatedAutomationDialog
        workflowId={workflowId}
        open={createDialog === "notion-page-content-updated"}
        onOpenChange={(open) => {
          setCreateDialog(open ? "notion-page-content-updated" : null);
        }}
      />
      <CreateWebhookAutomationDialog
        workflowId={workflowId}
        open={createDialog === "webhook"}
        onOpenChange={(open) => {
          setCreateDialog(open ? "webhook" : null);
        }}
      />
      <WorkflowWebhookUpgradeDialog />
    </>
  );
}

function GithubWebhookAutomationCreateDialogs({
  workflowId,
  createDialog,
  setCreateDialog,
}: {
  readonly workflowId: string;
  readonly createDialog: WorkflowAutomationCreateDialog;
  readonly setCreateDialog: (dialog: WorkflowAutomationCreateDialog) => void;
}) {
  return (
    <>
      <CreateGithubWebhookAutomationDialog
        workflowId={workflowId}
        eventType="github-workflow-job-completed"
        open={createDialog === "github-workflow-job"}
        onOpenChange={(open) => {
          setCreateDialog(open ? "github-workflow-job" : null);
        }}
      />
      <CreateGithubWebhookAutomationDialog
        workflowId={workflowId}
        eventType="github-pull-request-review-submitted"
        open={createDialog === "github-pull-request-review"}
        onOpenChange={(open) => {
          setCreateDialog(open ? "github-pull-request-review" : null);
        }}
      />
      <CreateGithubWebhookAutomationDialog
        workflowId={workflowId}
        eventType="github-deployment-status-created"
        open={createDialog === "github-deployment-status"}
        onOpenChange={(open) => {
          setCreateDialog(open ? "github-deployment-status" : null);
        }}
      />
      <CreateGithubWebhookAutomationDialog
        workflowId={workflowId}
        eventType="github-issue-comment-created"
        open={createDialog === "github-issue-comment"}
        onOpenChange={(open) => {
          setCreateDialog(open ? "github-issue-comment" : null);
        }}
      />
    </>
  );
}

function CreateNotionDatabaseItemAutomationDialog({
  workflowId,
  open,
  onOpenChange,
}: {
  readonly workflowId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [createLoadable, createNotionAutomation] = useLoadableSet(
    createWorkflowNotionDatabaseItemAutomation$,
  );
  const creating = createLoadable.state === "loading";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Notion automation</DialogTitle>
          <DialogDescription>
            Run this workflow when a page is added to a Notion database.
          </DialogDescription>
        </DialogHeader>
        <form
          aria-label="Add Notion database item automation"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const databaseUrl = formTextValue(form, "databaseUrl");
            if (!databaseUrl) {
              return;
            }
            detach(
              (async () => {
                await createNotionAutomation(
                  {
                    workflowId,
                    eventConfig: {
                      provider: "notion",
                      event: "database_item_created",
                      databaseUrl,
                    },
                  },
                  pageSignal,
                );
                onOpenChange(false);
              })(),
              Reason.DomCallback,
            );
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Database URL
            <input
              name="databaseUrl"
              aria-label="Database URL"
              required
              disabled={creating}
              placeholder="https://www.notion.so/..."
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
              ) : (
                <IconBrandNotion size={14} stroke={1.5} />
              )}
              Add Notion automation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function notionPageContentUpdatedEventConfigFromForm(
  form: FormData,
  scope: NotionPageContentUpdatedScopeMode,
): NotionPageContentUpdatedEventCreateConfig | null {
  const pageUrl = formTextValue(form, "pageUrl");
  const databaseUrl = formTextValue(form, "databaseUrl");
  if (scope === "page") {
    return pageUrl
      ? {
          provider: "notion",
          event: "page_content_updated",
          pageUrl,
        }
      : null;
  }
  return databaseUrl
    ? {
        provider: "notion",
        event: "page_content_updated",
        databaseUrl,
      }
    : null;
}

function NotionPageContentUpdatedScopeFields({
  scope,
  creating,
  setScope,
}: {
  readonly scope: NotionPageContentUpdatedScopeMode;
  readonly creating: boolean;
  readonly setScope: (scope: NotionPageContentUpdatedScopeMode) => void;
}) {
  return (
    <>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Scope
        <Select
          value={scope}
          disabled={creating}
          onValueChange={(value) => {
            setScope(value === "database" ? "database" : "page");
          }}
        >
          <SelectTrigger aria-label="Notion content update scope">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="page">Page</SelectItem>
            <SelectItem value="database">Database</SelectItem>
          </SelectContent>
        </Select>
      </label>
      {scope === "page" ? (
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Page URL
          <input
            name="pageUrl"
            aria-label="Page URL"
            required
            disabled={creating}
            placeholder="https://www.notion.so/workspace/Page-title-..."
            className={FIELD_CLASS}
          />
        </label>
      ) : (
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Database URL
          <input
            name="databaseUrl"
            aria-label="Database URL"
            required
            disabled={creating}
            placeholder="https://www.notion.so/..."
            className={FIELD_CLASS}
          />
        </label>
      )}
    </>
  );
}

function CreateNotionPageContentUpdatedAutomationDialog({
  workflowId,
  open,
  onOpenChange,
}: {
  readonly workflowId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const scope = useGet(createNotionPageContentUpdatedScope$);
  const setScope = useSet(setCreateNotionPageContentUpdatedScope$);
  const [createLoadable, createNotionAutomation] = useLoadableSet(
    createWorkflowNotionPageContentUpdatedAutomation$,
  );
  const creating = createLoadable.state === "loading";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Notion automation</DialogTitle>
          <DialogDescription>
            Run this workflow when a Notion page content update settles.
          </DialogDescription>
        </DialogHeader>
        <form
          aria-label="Add Notion page content updated automation"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const eventConfig = notionPageContentUpdatedEventConfigFromForm(
              form,
              scope,
            );
            if (!eventConfig) {
              return;
            }
            detach(
              (async () => {
                await createNotionAutomation(
                  {
                    workflowId,
                    eventConfig,
                  },
                  pageSignal,
                );
                onOpenChange(false);
              })(),
              Reason.DomCallback,
            );
          }}
        >
          <NotionPageContentUpdatedScopeFields
            scope={scope}
            creating={creating}
            setScope={setScope}
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
              ) : (
                <IconBrandNotion size={14} stroke={1.5} />
              )}
              Add Notion automation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreateNotionChildPageAutomationDialog({
  workflowId,
  open,
  onOpenChange,
}: {
  readonly workflowId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [createLoadable, createNotionAutomation] = useLoadableSet(
    createWorkflowNotionChildPageAutomation$,
  );
  const creating = createLoadable.state === "loading";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Notion automation</DialogTitle>
          <DialogDescription>
            Run this workflow when a direct child page is created under a Notion
            page.
          </DialogDescription>
        </DialogHeader>
        <form
          aria-label="Add Notion child page automation"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const parentPageUrl = formTextValue(form, "parentPageUrl");
            if (!parentPageUrl) {
              return;
            }
            detach(
              (async () => {
                await createNotionAutomation(
                  {
                    workflowId,
                    eventConfig: {
                      provider: "notion",
                      event: "child_page_created",
                      parentPageUrl,
                    },
                  },
                  pageSignal,
                );
                onOpenChange(false);
              })(),
              Reason.DomCallback,
            );
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Parent page URL
            <input
              name="parentPageUrl"
              aria-label="Parent page URL"
              required
              disabled={creating}
              placeholder="https://www.notion.so/workspace/Page-title-..."
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
              ) : (
                <IconBrandNotion size={14} stroke={1.5} />
              )}
              Add Notion automation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreateIntervalAutomationDialog({
  workflowId,
  open,
  onOpenChange,
}: {
  readonly workflowId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [createLoadable, createScheduleAutomation] = useLoadableSet(
    createWorkflowScheduleAutomation$,
  );
  const creating = createLoadable.state === "loading";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add interval automation</DialogTitle>
          <DialogDescription>
            Choose how often this workflow should run.
          </DialogDescription>
        </DialogHeader>
        <form
          aria-label="Add interval automation"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const schedule = buildAutomationSchedule(
              "loop",
              {
                cronFields: defaultWorkflowCronFields(),
                intervalSeconds: String(form.get("intervalSeconds") ?? ""),
                atTime: "",
              },
              AUTOMATION_TIMEZONE,
            );
            if (!schedule) {
              return;
            }
            detach(
              (async () => {
                await createScheduleAutomation(
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

function CreateScheduledAutomationDialog({
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
  const [createLoadable, createScheduleAutomation] = useLoadableSet(
    createWorkflowScheduleAutomation$,
  );
  const creating = createLoadable.state === "loading";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add schedule automation</DialogTitle>
          <DialogDescription>
            Choose when this workflow should run.
          </DialogDescription>
        </DialogHeader>
        <form
          aria-label="Add schedule automation"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const schedule = buildAutomationSchedule(
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
                await createScheduleAutomation(
                  { workflowId, schedule },
                  pageSignal,
                );
                onOpenChange(false);
              })(),
              Reason.DomCallback,
            );
          }}
        >
          <ScheduleAutomationFields
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

function CreateOnceAutomationDialog({
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
  const pageSignal = useGet(pageSignal$);
  const setCronFields = useSet(setCreateScheduleCronFields$);
  const [createLoadable, createScheduleAutomation] = useLoadableSet(
    createWorkflowScheduleAutomation$,
  );
  const creating = createLoadable.state === "loading";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add one-time automation</DialogTitle>
          <DialogDescription>
            Choose the date and time for this workflow to run once.
          </DialogDescription>
        </DialogHeader>
        <form
          aria-label="Add one-time automation"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const schedule = buildAutomationSchedule(
              "once",
              {
                cronFields: defaultWorkflowCronFields(),
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
                await createScheduleAutomation(
                  { workflowId, schedule },
                  pageSignal,
                );
                onOpenChange(false);
              })(),
              Reason.DomCallback,
            );
          }}
        >
          <ScheduleAutomationFields
            scheduleType="once"
            cronFields={defaultWorkflowCronFields()}
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
              Add one-time run
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ScheduleAutomationFields({
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
          Displays in {displayTimezone}.
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

function updateGmailMatchCondition(
  conditions: readonly GmailMatchCondition[],
  index: number,
  update: Partial<GmailMatchCondition>,
): readonly GmailMatchCondition[] {
  return conditions.map((condition, conditionIndex) => {
    return conditionIndex === index ? { ...condition, ...update } : condition;
  });
}

function gmailMatchConditionUsed(
  conditions: readonly GmailMatchCondition[],
  index: number,
  field: GmailTextField,
  operator: GmailTextOperator,
): boolean {
  return conditions.some((condition, conditionIndex) => {
    return (
      conditionIndex !== index &&
      condition.field === field &&
      condition.operator === operator
    );
  });
}

function GmailMatchConditionRow({
  condition,
  conditions,
  index,
  disabled,
  onChange,
}: {
  readonly condition: GmailMatchCondition;
  readonly conditions: readonly GmailMatchCondition[];
  readonly index: number;
  readonly disabled: boolean;
  readonly onChange: (conditions: readonly GmailMatchCondition[]) => void;
}) {
  const fieldLabel = gmailTextFieldOption(condition.field).label;
  const operatorLabel = gmailTextOperatorOption(condition.operator).label;
  const updateCondition = (update: Partial<GmailMatchCondition>) => {
    onChange(updateGmailMatchCondition(conditions, index, update));
  };

  return (
    <div className="group grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_2.25rem] items-center gap-2 sm:grid-cols-[minmax(0,0.85fr)_minmax(0,1.35fr)_minmax(0,2fr)_2.25rem]">
      <Select
        value={condition.field}
        disabled={disabled}
        onValueChange={(value) => {
          updateCondition({ field: gmailTextFieldOption(value).field });
        }}
      >
        <SelectTrigger aria-label={`Condition ${index + 1} field`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {GMAIL_TEXT_FIELDS.map((option) => {
            return (
              <SelectItem
                key={option.field}
                value={option.field}
                disabled={gmailMatchConditionUsed(
                  conditions,
                  index,
                  option.field,
                  condition.operator,
                )}
              >
                {option.label}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      <Select
        value={condition.operator}
        disabled={disabled}
        onValueChange={(value) => {
          updateCondition({
            operator: gmailTextOperatorOption(value).operator,
          });
        }}
      >
        <SelectTrigger aria-label={`Condition ${index + 1} operator`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {GMAIL_TEXT_OPERATORS.map((option) => {
            return (
              <SelectItem
                key={option.operator}
                value={option.operator}
                disabled={gmailMatchConditionUsed(
                  conditions,
                  index,
                  condition.field,
                  option.operator,
                )}
              >
                {option.label}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      <Input
        name={`${condition.field}${condition.operator === "contains" ? "Contains" : "DoesNotContain"}`}
        aria-label={`${fieldLabel} ${operatorLabel.toLowerCase()}`}
        value={condition.value}
        disabled={disabled}
        placeholder="Enter a value"
        className="col-span-2 row-start-2 sm:col-auto sm:row-auto"
        onChange={(event) => {
          updateCondition({ value: event.currentTarget.value });
        }}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`Remove condition ${index + 1}`}
        disabled={disabled || conditions.length === 1}
        className="col-start-3 row-start-1 h-9 w-9 shrink-0 text-muted-foreground hover:bg-gray-50 hover:text-foreground sm:col-auto sm:row-auto [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100"
        onClick={() => {
          onChange(
            conditions.filter((_, conditionIndex) => {
              return conditionIndex !== index;
            }),
          );
        }}
      >
        <IconX size={16} stroke={1.5} />
      </Button>
    </div>
  );
}

function GmailMatchConditionsEditor({
  conditions,
  disabled,
  onChange,
}: {
  readonly conditions: readonly GmailMatchCondition[];
  readonly disabled: boolean;
  readonly onChange: (conditions: readonly GmailMatchCondition[]) => void;
}) {
  const nextCondition = nextGmailMatchCondition(conditions);
  return (
    <div className="flex flex-col gap-2">
      {conditions.map((condition, index) => {
        return (
          <GmailMatchConditionRow
            key={`${condition.field}-${condition.operator}`}
            condition={condition}
            conditions={conditions}
            index={index}
            disabled={disabled}
            onChange={onChange}
          />
        );
      })}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled || !nextCondition}
        className="-ml-2 w-fit px-2 font-normal"
        onClick={() => {
          if (nextCondition) {
            onChange([...conditions, nextCondition]);
          }
        }}
      >
        <IconPlus size={14} stroke={1.5} />
        Add condition
      </Button>
    </div>
  );
}

function CreateGmailNewMessageAutomationDialog({
  workflowId,
  open,
  onOpenChange,
}: {
  readonly workflowId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [createLoadable, createGmailAutomation] = useLoadableSet(
    createWorkflowGmailNewMessageAutomation$,
  );
  const matchConditions = useGet(createGmailMatchConditions$);
  const setMatchConditions = useSet(setCreateGmailMatchConditions$);
  const creating = createLoadable.state === "loading";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add Gmail automation</DialogTitle>
          <DialogDescription>
            Run this workflow when a matching message arrives.
          </DialogDescription>
        </DialogHeader>
        <form
          aria-label="Add Gmail automation"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            detach(
              (async () => {
                await createGmailAutomation(
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
          <GmailMatchConditionsEditor
            conditions={matchConditions}
            disabled={creating}
            onChange={setMatchConditions}
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
              Add Gmail automation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function signedWebhookCurlExample(
  automation: Pick<
    WebhookWorkflowAutomationSummary,
    "webhookSecret" | "webhookUrl"
  >,
): string {
  const secret = automation.webhookSecret ?? "<signing-secret>";
  const webhookUrl = automation.webhookUrl ?? "<webhook-url>";
  return [
    `BODY='{"hello":"world"}'`,
    "TIMESTAMP=$(date +%s)",
    `SIGNATURE=$(printf "%s.%s" "$TIMESTAMP" "$BODY" | openssl dgst -sha256 -hmac "${secret}" -hex | awk '{print $2}')`,
    `curl -X POST "${webhookUrl}" \\`,
    '  -H "Content-Type: application/json" \\',
    '  -H "X-VM0-Timestamp: $TIMESTAMP" \\',
    '  -H "X-VM0-Signature: $SIGNATURE" \\',
    '  --data "$BODY"',
  ].join("\n");
}

function CreateGmailLabelAppliedAutomationDialog({
  workflowId,
  open,
  onOpenChange,
}: {
  readonly workflowId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [createLoadable, createGmailLabelAutomation] = useLoadableSet(
    createWorkflowGmailLabelAppliedAutomation$,
  );
  const creating = createLoadable.state === "loading";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Gmail label automation</DialogTitle>
          <DialogDescription>
            Run this workflow when a named Gmail label is applied.
          </DialogDescription>
        </DialogHeader>
        <form
          aria-label="Add Gmail label automation"
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
                await createGmailLabelAutomation(
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
              Add label automation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function GithubLabelAutomationFields({
  disabled,
  actor,
  defaultConfig,
  onActorChange,
}: {
  readonly disabled: boolean;
  readonly actor: "me" | "anyone";
  readonly defaultConfig?: GithubLabelAppliedEventConfig;
  readonly onActorChange: (actor: "me" | "anyone") => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Label name
        <input
          name="labelName"
          aria-label="GitHub label name"
          required
          disabled={disabled}
          defaultValue={defaultConfig?.labelName ?? ""}
          placeholder="triage"
          className={FIELD_CLASS}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Subject
        <Select
          name="subject"
          defaultValue={defaultConfig?.filters.subject ?? "both"}
          disabled={disabled}
        >
          <SelectTrigger className="h-9 w-full" aria-label="Subject">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {GITHUB_SUBJECT_OPTIONS.map((option) => {
              return (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Started by
        <Select
          name="actor"
          value={actor}
          disabled={disabled}
          onValueChange={(value) => {
            onActorChange(value === "anyone" ? "anyone" : "me");
          }}
        >
          <SelectTrigger className="h-9 w-full" aria-label="Started by">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {GITHUB_ACTOR_OPTIONS.map((option) => {
              return (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </label>
    </div>
  );
}

function GithubWorkflowRunAutomationFields({
  disabled,
  defaultConfig,
}: {
  readonly disabled: boolean;
  readonly defaultConfig?: GithubWorkflowRunCompletedEventConfig;
}) {
  const filters = defaultConfig?.filters;
  const fields: readonly {
    readonly name: string;
    readonly label: string;
    readonly placeholder: string;
    readonly defaultValues: readonly string[] | undefined;
  }[] = [
    {
      name: "repositories",
      label: "Repositories",
      placeholder: "vm0-ai/vm0, owner/another-repo",
      defaultValues: filters?.repositories,
    },
    {
      name: "workflows",
      label: "GitHub workflows",
      placeholder: "Turbo, .github/workflows/release.yml",
      defaultValues: filters?.workflows,
    },
    {
      name: "branches",
      label: "Branches",
      placeholder: "main, release",
      defaultValues: filters?.branches,
    },
    {
      name: "events",
      label: "Triggering events",
      placeholder: "push, pull_request, workflow_dispatch",
      defaultValues: filters?.events,
    },
    {
      name: "actors",
      label: "Actors",
      placeholder: "octocat, dependabot[bot]",
      defaultValues: filters?.actors,
    },
  ];
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Leave a filter empty to match any value. Separate multiple values with
        commas.
      </p>
      {fields.map((field) => {
        return (
          <label
            key={field.name}
            className="flex flex-col gap-1 text-xs text-muted-foreground"
          >
            {field.label}
            <input
              name={field.name}
              aria-label={field.label}
              disabled={disabled}
              defaultValue={field.defaultValues?.join(", ") ?? ""}
              placeholder={field.placeholder}
              className={FIELD_CLASS}
            />
          </label>
        );
      })}
      <fieldset className="flex flex-col gap-2">
        <legend className="text-xs text-muted-foreground">Conclusions</legend>
        <div className="grid grid-cols-2 gap-2">
          {GITHUB_WORKFLOW_RUN_CONCLUSION_OPTIONS.map((option) => {
            return (
              <label
                key={option.value}
                className="flex items-center gap-2 text-xs text-foreground"
              >
                <input
                  type="checkbox"
                  name="conclusions"
                  value={option.value}
                  disabled={disabled}
                  defaultChecked={filters?.conclusions?.includes(option.value)}
                  className="size-4 accent-primary"
                />
                {option.label}
              </label>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          Select none to match any completed conclusion.
        </p>
      </fieldset>
    </div>
  );
}

function GithubFilterInput({
  name,
  label,
  placeholder,
  defaultValues,
  disabled,
}: {
  readonly name: string;
  readonly label: string;
  readonly placeholder: string;
  readonly defaultValues?: readonly string[];
  readonly disabled: boolean;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <input
        name={name}
        aria-label={label}
        disabled={disabled}
        defaultValue={defaultValues?.join(", ") ?? ""}
        placeholder={placeholder}
        className={FIELD_CLASS}
      />
    </label>
  );
}

function GithubCheckboxFilters<T extends string>({
  name,
  label,
  options,
  selected,
  disabled,
}: {
  readonly name: string;
  readonly label: string;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly selected?: readonly T[];
  readonly disabled: boolean;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-xs text-muted-foreground">{label}</legend>
      <div className="grid grid-cols-2 gap-2">
        {options.map((option) => {
          return (
            <label
              key={option.value}
              className="flex items-center gap-2 text-xs text-foreground"
            >
              <input
                type="checkbox"
                name={name}
                value={option.value}
                disabled={disabled}
                defaultChecked={selected?.includes(option.value)}
                className="size-4 accent-primary"
              />
              {option.label}
            </label>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        Select none to match any value.
      </p>
    </fieldset>
  );
}

function GithubWorkflowJobAutomationFields({
  disabled,
  config,
}: {
  readonly disabled: boolean;
  readonly config?: GithubWorkflowJobCompletedEventConfig;
}) {
  return (
    <>
      <GithubFilterInput
        name="workflows"
        label="GitHub workflows"
        placeholder="Turbo, release"
        defaultValues={config?.filters.workflows}
        disabled={disabled}
      />
      <GithubFilterInput
        name="jobs"
        label="Jobs"
        placeholder="test, build"
        defaultValues={config?.filters.jobs}
        disabled={disabled}
      />
      <GithubFilterInput
        name="branches"
        label="Branches"
        placeholder="main, release"
        defaultValues={config?.filters.branches}
        disabled={disabled}
      />
      <GithubFilterInput
        name="runnerLabels"
        label="Runner labels"
        placeholder="self-hosted, linux"
        defaultValues={config?.filters.runnerLabels}
        disabled={disabled}
      />
      <GithubFilterInput
        name="runnerGroups"
        label="Runner groups"
        placeholder="Default, production"
        defaultValues={config?.filters.runnerGroups}
        disabled={disabled}
      />
      <GithubCheckboxFilters
        name="conclusions"
        label="Conclusions"
        options={GITHUB_WORKFLOW_RUN_CONCLUSION_OPTIONS}
        selected={config?.filters.conclusions}
        disabled={disabled}
      />
    </>
  );
}

function GithubReviewAutomationFields({
  disabled,
  config,
}: {
  readonly disabled: boolean;
  readonly config?: GithubPullRequestReviewSubmittedEventConfig;
}) {
  return (
    <>
      <GithubFilterInput
        name="baseBranches"
        label="Base branches"
        placeholder="main, release"
        defaultValues={config?.filters.baseBranches}
        disabled={disabled}
      />
      <GithubFilterInput
        name="headBranches"
        label="Head branches"
        placeholder="feature/, dependabot/"
        defaultValues={config?.filters.headBranches}
        disabled={disabled}
      />
      <GithubFilterInput
        name="trustedAuthors"
        label="Trusted authors"
        placeholder="octocat, e7h4n"
        defaultValues={config?.filters.trustedAuthors}
        disabled={disabled}
      />
      <GithubCheckboxFilters
        name="reviewStates"
        label="Review states"
        options={GITHUB_REVIEW_STATE_OPTIONS}
        selected={config?.filters.reviewStates}
        disabled={disabled}
      />
    </>
  );
}

function GithubDeploymentAutomationFields({
  disabled,
  config,
}: {
  readonly disabled: boolean;
  readonly config?: GithubDeploymentStatusCreatedEventConfig;
}) {
  const productionEnvironment = config?.filters.productionEnvironment;
  return (
    <>
      <GithubFilterInput
        name="environments"
        label="Environments"
        placeholder="Preview, Production"
        defaultValues={config?.filters.environments}
        disabled={disabled}
      />
      <GithubFilterInput
        name="refs"
        label="Refs"
        placeholder="main, v1.0.0"
        defaultValues={config?.filters.refs}
        disabled={disabled}
      />
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Production environment
        <Select
          name="productionEnvironment"
          defaultValue={
            productionEnvironment === undefined
              ? "any"
              : String(productionEnvironment)
          }
          disabled={disabled}
        >
          <SelectTrigger
            className="h-9 w-full"
            aria-label="Production environment"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any</SelectItem>
            <SelectItem value="true">Production only</SelectItem>
            <SelectItem value="false">Non-production only</SelectItem>
          </SelectContent>
        </Select>
      </label>
      <GithubFilterInput
        name="creators"
        label="Creators"
        placeholder="octocat, 12345"
        defaultValues={config?.filters.creators}
        disabled={disabled}
      />
      <GithubFilterInput
        name="apps"
        label="GitHub Apps"
        placeholder="vercel, 12345"
        defaultValues={config?.filters.apps}
        disabled={disabled}
      />
      <GithubCheckboxFilters
        name="deploymentStates"
        label="Deployment states"
        options={GITHUB_DEPLOYMENT_STATE_OPTIONS}
        selected={config?.filters.states}
        disabled={disabled}
      />
    </>
  );
}

function GithubCommentAutomationFields({
  disabled,
  config,
}: {
  readonly disabled: boolean;
  readonly config?: GithubIssueCommentCreatedEventConfig;
}) {
  return (
    <>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Subject
        <Select
          name="subject"
          defaultValue={config?.filters.subject ?? "both"}
          disabled={disabled}
        >
          <SelectTrigger className="h-9 w-full" aria-label="Subject">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {GITHUB_SUBJECT_OPTIONS.map((option) => {
              return (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </label>
      <GithubFilterInput
        name="trustedAuthors"
        label="Trusted authors"
        placeholder="octocat, e7h4n"
        defaultValues={config?.filters.trustedAuthors}
        disabled={disabled}
      />
      <GithubFilterInput
        name="commentPrefixes"
        label="Comment prefixes"
        placeholder="/zero, /verify, /deploy"
        defaultValues={config?.filters.commentPrefixes}
        disabled={disabled}
      />
    </>
  );
}

function githubWebhookAutomationSpecificFields(
  eventType: GithubWebhookAutomationEventType,
  disabled: boolean,
  defaultConfig: GithubWebhookAutomationEventConfig | undefined,
): ReactNode {
  switch (eventType) {
    case "github-workflow-job-completed": {
      const config =
        defaultConfig?.event === "workflow_job_completed"
          ? defaultConfig
          : undefined;
      return (
        <GithubWorkflowJobAutomationFields
          disabled={disabled}
          config={config}
        />
      );
    }
    case "github-pull-request-review-submitted": {
      const config =
        defaultConfig?.event === "pull_request_review_submitted"
          ? defaultConfig
          : undefined;
      return (
        <GithubReviewAutomationFields disabled={disabled} config={config} />
      );
    }
    case "github-deployment-status-created": {
      const config =
        defaultConfig?.event === "deployment_status_created"
          ? defaultConfig
          : undefined;
      return (
        <GithubDeploymentAutomationFields disabled={disabled} config={config} />
      );
    }
    case "github-issue-comment-created": {
      const config =
        defaultConfig?.event === "issue_comment_created"
          ? defaultConfig
          : undefined;
      return (
        <GithubCommentAutomationFields disabled={disabled} config={config} />
      );
    }
  }
}

function GithubWebhookAutomationFields({
  eventType,
  disabled,
  defaultConfig,
}: {
  readonly eventType: GithubWebhookAutomationEventType;
  readonly disabled: boolean;
  readonly defaultConfig?: GithubWebhookAutomationEventConfig;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Leave a filter empty to match any value. Separate multiple values with
        commas.
      </p>
      <GithubFilterInput
        name="repositories"
        label="Repositories"
        placeholder="vm0-ai/vm0, owner/another-repo"
        defaultValues={defaultConfig?.filters.repositories}
        disabled={disabled}
      />
      {githubWebhookAutomationSpecificFields(
        eventType,
        disabled,
        defaultConfig,
      )}
    </div>
  );
}

function GithubLabelAutomationAvailabilityMessages({
  githubLoaded,
  isInstalled,
  needsConnection,
  githubLoadError,
  connecting,
  onConnect,
}: {
  readonly githubLoaded: boolean;
  readonly isInstalled: boolean;
  readonly needsConnection: boolean;
  readonly githubLoadError: boolean;
  readonly connecting: boolean;
  readonly onConnect: () => void;
}) {
  return (
    <>
      {githubLoaded && !isInstalled ? <GithubNotInstalledNotice /> : null}
      {needsConnection ? (
        <GithubAccountConnectionNotice
          connecting={connecting}
          onConnect={onConnect}
        />
      ) : null}
      {githubLoadError ? <GithubLoadErrorNotice /> : null}
    </>
  );
}

function GithubNotInstalledNotice() {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      GitHub is not installed for this workspace.
    </div>
  );
}

function GithubAccountConnectionNotice({
  connecting,
  onConnect,
}: {
  readonly connecting: boolean;
  readonly onConnect: () => void;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      Connect your GitHub account to use Me.
      <Button
        type="button"
        variant="link"
        disabled={connecting}
        className="ml-1 h-auto p-0 text-xs"
        onClick={onConnect}
      >
        Connect GitHub
      </Button>
    </div>
  );
}

function GithubLoadErrorNotice() {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      GitHub settings could not be loaded.
    </div>
  );
}

function CreateGithubLabelAppliedAutomationDialog({
  workflowId,
  open,
  onOpenChange,
}: {
  readonly workflowId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const githubLoadable = useLoadable(githubIntegrationData$);
  const githubData =
    githubLoadable.state === "hasData" ? githubLoadable.data : null;
  const actor = useGet(createGithubLabelActor$);
  const setActor = useSet(setCreateGithubLabelActor$);
  const [createLoadable, createGithubLabelAutomation] = useLoadableSet(
    createWorkflowGithubLabelAppliedAutomation$,
  );
  const [connectLoadable, connectGithub] = useLoadableSet(
    connectGithubInstallation$,
  );
  const creating = createLoadable.state === "loading";
  const connecting = connectLoadable.state === "loading";
  const loadingGithub = githubLoadable.state === "loading";
  const githubLoadError = githubLoadable.state === "hasError";
  const isInstalled = githubData?.isInstalled ?? false;
  const needsConnection =
    isInstalled && actor === "me" && !githubData?.isConnected;
  const submitDisabled =
    creating ||
    loadingGithub ||
    githubLoadError ||
    !isInstalled ||
    needsConnection;
  const connectCurrentGithubAccount = () => {
    if (!githubData) {
      return;
    }
    detach(
      connectGithub(githubData.connectUrl, pageSignal),
      Reason.DomCallback,
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          setActor("me");
        }
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add GitHub label automation</DialogTitle>
          <DialogDescription>
            Run this workflow when a GitHub label is applied.
          </DialogDescription>
        </DialogHeader>
        <form
          aria-label="Add GitHub label automation"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const eventConfig = buildGithubLabelAppliedEventConfig(form);
            if (!eventConfig) {
              return;
            }
            detach(
              (async () => {
                await createGithubLabelAutomation(
                  { workflowId, eventConfig },
                  pageSignal,
                );
                onOpenChange(false);
              })(),
              Reason.DomCallback,
            );
          }}
        >
          <GithubLabelAutomationFields
            disabled={creating || loadingGithub || githubLoadError}
            actor={actor}
            onActorChange={setActor}
          />
          <GithubLabelAutomationAvailabilityMessages
            githubLoaded={githubLoadable.state === "hasData"}
            isInstalled={isInstalled}
            needsConnection={needsConnection}
            githubLoadError={githubLoadError}
            connecting={connecting}
            onConnect={connectCurrentGithubAccount}
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
            <Button type="submit" disabled={submitDisabled}>
              {creating ? (
                <IconLoader2 size={14} className="animate-spin" />
              ) : null}
              Add label automation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreateGithubWorkflowRunCompletedAutomationDialog({
  workflowId,
  open,
  onOpenChange,
}: {
  readonly workflowId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const githubLoadable = useLoadable(githubIntegrationData$);
  const githubData =
    githubLoadable.state === "hasData" ? githubLoadable.data : null;
  const [createLoadable, createGithubWorkflowRunAutomation] = useLoadableSet(
    createWorkflowGithubWorkflowRunCompletedAutomation$,
  );
  const creating = createLoadable.state === "loading";
  const loadingGithub = githubLoadable.state === "loading";
  const githubLoadError = githubLoadable.state === "hasError";
  const isInstalled = githubData?.isInstalled ?? false;
  const submitDisabled =
    creating || loadingGithub || githubLoadError || !isInstalled;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add GitHub workflow automation</DialogTitle>
          <DialogDescription>
            Run this workflow when a matching GitHub Actions workflow run
            completes.
          </DialogDescription>
        </DialogHeader>
        <form
          aria-label="Add GitHub workflow automation"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const eventConfig = buildGithubWorkflowRunCompletedEventConfig(
              new FormData(event.currentTarget),
            );
            detach(
              (async () => {
                await createGithubWorkflowRunAutomation(
                  { workflowId, eventConfig },
                  pageSignal,
                );
                onOpenChange(false);
              })(),
              Reason.DomCallback,
            );
          }}
        >
          <GithubWorkflowRunAutomationFields
            disabled={creating || loadingGithub || githubLoadError}
          />
          {githubLoadable.state === "hasData" && !isInstalled ? (
            <GithubNotInstalledNotice />
          ) : null}
          {githubLoadError ? <GithubLoadErrorNotice /> : null}
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
            <Button type="submit" disabled={submitDisabled}>
              {creating ? (
                <IconLoader2 size={14} className="animate-spin" />
              ) : null}
              Add workflow automation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function githubWebhookAutomationTitle(
  eventType: GithubWebhookAutomationEventType,
): string {
  switch (eventType) {
    case "github-workflow-job-completed": {
      return "GitHub workflow job completed";
    }
    case "github-pull-request-review-submitted": {
      return "GitHub pull request review submitted";
    }
    case "github-deployment-status-created": {
      return "GitHub deployment status created";
    }
    case "github-issue-comment-created": {
      return "GitHub issue comment created";
    }
  }
}

function CreateGithubWebhookAutomationDialog({
  workflowId,
  eventType,
  open,
  onOpenChange,
}: {
  readonly workflowId: string;
  readonly eventType: GithubWebhookAutomationEventType;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const githubLoadable = useLoadable(githubIntegrationData$);
  const githubData =
    githubLoadable.state === "hasData" ? githubLoadable.data : null;
  const [createLoadable, createGithubWebhookAutomation] = useLoadableSet(
    createWorkflowGithubWebhookAutomation$,
  );
  const creating = createLoadable.state === "loading";
  const loadingGithub = githubLoadable.state === "loading";
  const githubLoadError = githubLoadable.state === "hasError";
  const isInstalled = githubData?.isInstalled ?? false;
  const submitDisabled =
    creating || loadingGithub || githubLoadError || !isInstalled;
  const title = githubWebhookAutomationTitle(eventType);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add {title}</DialogTitle>
          <DialogDescription>
            Run this workflow when a matching GitHub webhook event arrives.
          </DialogDescription>
        </DialogHeader>
        <form
          aria-label={`Add ${title} automation`}
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const eventConfig = buildGithubWebhookEventConfig(
              eventType,
              new FormData(event.currentTarget),
            );
            detach(
              (async () => {
                if (
                  eventType === "github-workflow-job-completed" &&
                  eventConfig.event === "workflow_job_completed"
                ) {
                  await createGithubWebhookAutomation(
                    { workflowId, eventType, eventConfig },
                    pageSignal,
                  );
                } else if (
                  eventType === "github-pull-request-review-submitted" &&
                  eventConfig.event === "pull_request_review_submitted"
                ) {
                  await createGithubWebhookAutomation(
                    { workflowId, eventType, eventConfig },
                    pageSignal,
                  );
                } else if (
                  eventType === "github-deployment-status-created" &&
                  eventConfig.event === "deployment_status_created"
                ) {
                  await createGithubWebhookAutomation(
                    { workflowId, eventType, eventConfig },
                    pageSignal,
                  );
                } else if (
                  eventType === "github-issue-comment-created" &&
                  eventConfig.event === "issue_comment_created"
                ) {
                  await createGithubWebhookAutomation(
                    { workflowId, eventType, eventConfig },
                    pageSignal,
                  );
                }
                onOpenChange(false);
              })(),
              Reason.DomCallback,
            );
          }}
        >
          <GithubWebhookAutomationFields
            eventType={eventType}
            disabled={creating || loadingGithub || githubLoadError}
          />
          {githubLoadable.state === "hasData" && !isInstalled ? (
            <GithubNotInstalledNotice />
          ) : null}
          {githubLoadError ? <GithubLoadErrorNotice /> : null}
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
            <Button type="submit" disabled={submitDisabled}>
              {creating ? (
                <IconLoader2 size={14} className="animate-spin" />
              ) : (
                <IconBrandGithub size={14} stroke={1.5} />
              )}
              Add automation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreateGoogleCalendarEventAutomationDialog({
  workflowId,
  eventType,
  open,
  onOpenChange,
}: {
  readonly workflowId: string;
  readonly eventType: GoogleCalendarAutomationEventType;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [createLoadable, createGoogleCalendarAutomation] = useLoadableSet(
    createWorkflowGoogleCalendarEventAutomation$,
  );
  const creating = createLoadable.state === "loading";
  const isUpdated = eventType === "google-calendar-event-updated";
  const isCancelled = eventType === "google-calendar-event-cancelled";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Google Calendar automation</DialogTitle>
          <DialogDescription>
            {isCancelled
              ? "Run this workflow when a Google Calendar event is cancelled."
              : isUpdated
                ? "Run this workflow when a Google Calendar event is updated."
                : "Run this workflow when a new Google Calendar event is created."}
          </DialogDescription>
        </DialogHeader>
        <form
          aria-label="Add Google Calendar automation"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            detach(
              (async () => {
                const calendarId = googleCalendarIdFromForm(form);
                if (eventType === "google-calendar-event-created") {
                  await createGoogleCalendarAutomation(
                    {
                      workflowId,
                      eventType: "google-calendar-event-created",
                      eventConfig: {
                        provider: "google-calendar",
                        event: "event_created",
                        calendarId,
                      },
                    },
                    pageSignal,
                  );
                } else if (eventType === "google-calendar-event-updated") {
                  await createGoogleCalendarAutomation(
                    {
                      workflowId,
                      eventType: "google-calendar-event-updated",
                      eventConfig: {
                        provider: "google-calendar",
                        event: "event_updated",
                        calendarId,
                      },
                    },
                    pageSignal,
                  );
                } else {
                  await createGoogleCalendarAutomation(
                    {
                      workflowId,
                      eventType: "google-calendar-event-cancelled",
                      eventConfig: {
                        provider: "google-calendar",
                        event: "event_cancelled",
                        calendarId,
                      },
                    },
                    pageSignal,
                  );
                }
                onOpenChange(false);
              })(),
              Reason.DomCallback,
            );
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Calendar ID
            <input
              name="calendarId"
              aria-label="Calendar ID"
              disabled={creating}
              defaultValue="primary"
              placeholder="primary"
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
              Add Calendar automation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreateWebhookAutomationDialog({
  workflowId,
  open,
  onOpenChange,
}: {
  readonly workflowId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const createdAutomation = useGet(createdWorkflowWebhookAutomation$);
  const setCreatedAutomation = useSet(setCreatedWorkflowWebhookAutomation$);
  const reloadWorkflows = useSet(reloadWorkflows$);
  const [createLoadable, createWebhookAutomation] = useLoadableSet(
    createWorkflowWebhookAutomation$,
  );
  const creating = createLoadable.state === "loading";

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          if (createdAutomation) {
            reloadWorkflows();
          }
          setCreatedAutomation(null);
        }
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add webhook automation</DialogTitle>
          <DialogDescription>
            Create a signed endpoint for this workflow.
          </DialogDescription>
        </DialogHeader>
        {createdAutomation ? (
          <CreatedWebhookAutomationView
            automation={createdAutomation}
            onDone={() => {
              reloadWorkflows();
              setCreatedAutomation(null);
              onOpenChange(false);
            }}
          />
        ) : (
          <CreateWebhookAutomationView
            creating={creating}
            onCancel={() => {
              onOpenChange(false);
            }}
            onCreate={() => {
              detach(
                (async () => {
                  const automation = await createWebhookAutomation(
                    { workflowId },
                    pageSignal,
                  );
                  if (automation) {
                    setCreatedAutomation(automation);
                  }
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

function CreatedWebhookAutomationView({
  automation,
  onDone,
}: {
  readonly automation: WebhookWorkflowAutomationSummary;
  readonly onDone: () => void;
}) {
  const curlExample = signedWebhookCurlExample(automation);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
        Webhook URL
        {automation.webhookUrl ? (
          <WebhookReadonlyField
            value={automation.webhookUrl}
            onCopy={() => {
              copyText(automation.webhookUrl ?? "");
            }}
          />
        ) : null}
      </label>
      {automation.webhookSecret ? (
        <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
          Signing secret
          <WebhookReadonlyField
            value={automation.webhookSecret}
            onCopy={() => {
              copyText(automation.webhookSecret ?? "");
            }}
          />
        </label>
      ) : null}
      <div className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
        Signed curl
        <div className="relative min-w-0">
          <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-all rounded-md border border-border/60 bg-muted/40 p-3 pr-20 font-mono text-xs leading-5 text-foreground">
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
      <input readOnly value={value} className={cn(FIELD_CLASS, "min-w-0")} />
      <Button type="button" variant="outline" onClick={onCopy}>
        <IconCopy size={14} />
        Copy
      </Button>
    </div>
  );
}

function RevealWebhookSecretDialog({
  automation,
  onOpenChange,
}: {
  readonly automation: WebhookWorkflowAutomationSummary;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [revealLoadable, revealSecret] = useLoadableSet(
    revealWorkflowWebhookSecret$,
  );
  const secret =
    revealLoadable.state === "hasData" ? revealLoadable.data : null;
  const revealing = revealLoadable.state === "loading";
  const curlExample = secret ? signedWebhookCurlExample(secret) : null;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>View webhook secret</DialogTitle>
          <DialogDescription>
            Reveal the signed endpoint and secret ending in{" "}
            {automation.secretLastFour}.
          </DialogDescription>
        </DialogHeader>
        {secret ? (
          <div className="flex min-w-0 flex-col gap-3">
            <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
              Webhook URL
              <WebhookReadonlyField
                value={secret.webhookUrl}
                onCopy={() => {
                  copyText(secret.webhookUrl);
                }}
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
              Signing secret
              <WebhookReadonlyField
                value={secret.webhookSecret}
                onCopy={() => {
                  copyText(secret.webhookSecret);
                }}
              />
            </label>
            {curlExample ? (
              <div className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                Signed curl
                <div className="relative min-w-0">
                  <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-all rounded-md border border-border/60 bg-muted/40 p-3 pr-20 font-mono text-xs leading-5 text-foreground">
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
            ) : null}
          </div>
        ) : (
          <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            Secret values are hidden from the automation list. Reveal them only
            when you need to configure or test this webhook.
          </div>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {secret ? "Done" : "Cancel"}
          </Button>
          {!secret ? (
            <Button
              type="button"
              disabled={revealing}
              onClick={() => {
                detach(
                  (async () => {
                    await revealSecret(
                      { automationId: automation.id },
                      pageSignal,
                    );
                  })(),
                  Reason.DomCallback,
                  "reveal workflow webhook secret",
                );
              }}
            >
              {revealing ? (
                <IconLoader2 size={14} className="animate-spin" />
              ) : (
                <IconEye size={14} stroke={1.5} />
              )}
              Reveal secret
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateWebhookAutomationView({
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

function AutomationRunStat({
  icon,
  label,
  value,
  emphasized,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly value: string;
  readonly emphasized: boolean;
}) {
  return (
    <div
      className="flex min-w-0 items-center gap-1.5"
      aria-label={`${label} run ${value}`}
    >
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="shrink-0 text-sm text-muted-foreground">{label}</span>
      <span
        className={cn(
          "min-w-0 truncate text-sm",
          emphasized ? "font-medium text-foreground" : "text-muted-foreground",
        )}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function AutomationRow({
  automation,
  canManage,
  displayTimezone,
  showDivider,
}: {
  readonly automation: ZeroWorkflowAutomationSummary;
  readonly canManage: boolean;
  readonly displayTimezone: string;
  readonly showDivider: boolean;
}) {
  const editingAutomationId = useGet(editingWorkflowAutomationId$);
  const setEditingAutomationId = useSet(setEditingWorkflowAutomationId$);
  const editing = editingAutomationId === automation.id;
  const title = workflowScheduleTitle(automation, displayTimezone);
  const subtitle = workflowAutomationSubtitle(automation);
  const hasLastRun = hasValidRunTimestamp(automation.lastRunAt);
  const hasNextRun = hasValidRunTimestamp(automation.nextRunAt);
  const lastRunLabel = formatWorkflowAutomationRun(
    automation.lastRunAt,
    displayTimezone,
  );
  const nextRunLabel = formatWorkflowAutomationNextRun(
    automation.nextRunAt,
    displayTimezone,
  );

  return (
    <>
      <div
        className={cn(
          "group grid min-w-0 grid-cols-1 gap-3 px-5 py-4 transition-colors first:rounded-t-2xl last:rounded-b-2xl hover:bg-gray-50 sm:grid-cols-[minmax(0,1.2fr)_minmax(9rem,0.9fr)_minmax(13.5rem,1.1fr)_auto_7.75rem] sm:items-center sm:gap-4",
          !automation.enabled && "opacity-75",
        )}
      >
        <div className="flex min-w-0 items-center gap-3">
          <AutomationListIcon automation={automation} size="sm" />
          <div className="min-w-0">
            <div
              className="truncate text-sm font-medium text-foreground"
              title={title}
            >
              {title}
            </div>
            {subtitle ? (
              <div
                className="mt-0.5 truncate text-xs text-muted-foreground"
                title={subtitle}
              >
                {subtitle}
              </div>
            ) : null}
          </div>
        </div>
        <AutomationRunStat
          icon={<IconHistory size={14} stroke={1.5} />}
          label="Last"
          value={lastRunLabel}
          emphasized={hasLastRun}
        />
        {automation.kind === "schedule" ? (
          <AutomationRunStat
            icon={<IconClock size={14} stroke={1.5} />}
            label="Next"
            value={nextRunLabel}
            emphasized={hasNextRun}
          />
        ) : (
          <div aria-hidden="true" />
        )}
        <AutomationStatusSwitch
          automation={automation}
          title={title}
          canManage={canManage}
        />
        {canManage ? (
          <AutomationControls
            automation={automation}
            displayTimezone={displayTimezone}
          />
        ) : (
          <div aria-hidden="true" />
        )}
      </div>
      {showDivider ? (
        <div className="mx-5 h-px bg-border/50" aria-hidden="true" />
      ) : null}
      {canManage ? (
        <EditWorkflowAutomationDialog
          automation={automation}
          displayTimezone={displayTimezone}
          open={editing}
          onOpenChange={(open) => {
            if (!open) {
              setEditingAutomationId(null);
            }
          }}
        />
      ) : null}
    </>
  );
}

function workflowAutomationSubtitle(
  automation: ZeroWorkflowAutomationSummary,
): string | null {
  if (
    isWebhookWorkflowAutomation(automation) &&
    automation.disabledReason === "paid_plan_required"
  ) {
    return "Disabled — paid plan required";
  }
  const matchSummary = workflowAutomationSummary(automation);
  if (matchSummary) {
    return matchSummary;
  }
  if (isWebhookWorkflowAutomation(automation)) {
    return "Webhook URL hidden";
  }
  return automationKindLabel(automation);
}

function hasValidRunTimestamp(value: string | null): boolean {
  if (!value) {
    return false;
  }

  return !Number.isNaN(new Date(value).getTime());
}

function formatWorkflowAutomationRun(
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

function formatWorkflowAutomationNextRun(
  value: string | null,
  displayTimezone: string,
): string {
  if (!value) {
    return "No upcoming run";
  }

  return formatWorkflowAutomationRun(value, displayTimezone);
}

function AutomationStatusSwitch({
  automation,
  title,
  canManage,
}: {
  readonly automation: ZeroWorkflowAutomationSummary;
  readonly title: string;
  readonly canManage: boolean;
}) {
  const pageSignal = useGet(pageSignal$);
  const [enabledLoadable, setEnabled] = useLoadableSet(
    setWorkflowAutomationEnabled$,
  );
  const toggling = enabledLoadable.state === "loading";

  return (
    <div className="flex items-center justify-start sm:justify-center">
      <LoadingSwitch
        checked={automation.enabled}
        loading={toggling}
        disabled={!canManage}
        ariaLabel={`${automation.enabled ? "Disable" : "Enable"} ${title}`}
        onCheckedChange={(enabled) => {
          detach(
            setEnabled({ automationId: automation.id, enabled }, pageSignal),
            Reason.DomCallback,
          );
        }}
      />
    </div>
  );
}

function AutomationControls({
  automation,
  displayTimezone,
}: {
  readonly automation: ZeroWorkflowAutomationSummary;
  readonly displayTimezone: string;
}) {
  const pageSignal = useGet(pageSignal$);
  const navigate = useSet(detachedNavigateTo$);
  const setEditingAutomationId = useSet(setEditingWorkflowAutomationId$);
  const setEditingScheduleCronFields = useSet(setEditingScheduleCronFields$);
  const revealWebhookSecretAutomationId = useGet(
    revealWebhookSecretAutomationId$,
  );
  const setRevealWebhookSecretAutomationId = useSet(
    setRevealWebhookSecretAutomationId$,
  );
  const [runNowLoadable, runNow] = useLoadableSet(runWorkflowAutomationNow$);
  const busy = runNowLoadable.state === "loading";
  const canEdit = canEditWorkflowAutomation(automation);
  const revealWebhookSecretOpen =
    revealWebhookSecretAutomationId === automation.id &&
    isWebhookWorkflowAutomation(automation);

  return (
    <div className="flex min-w-0 items-center justify-end pr-1.5">
      <TooltipProvider delayDuration={200}>
        <div className="flex items-center justify-end gap-1 opacity-100 transition-opacity pointer-events-auto [@media(hover:hover)]:pointer-events-none [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:pointer-events-auto [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:pointer-events-auto [@media(hover:hover)]:group-focus-within:opacity-100">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={busy}
                aria-label="Run now"
                className="h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:bg-gray-200 hover:text-foreground"
                onClick={() => {
                  detach(
                    (async () => {
                      const result = await runNow(automation.id, pageSignal);
                      navigate(ROUTES.chat, {
                        pathParams: { threadId: result.chatThreadId },
                      });
                    })(),
                    Reason.DomCallback,
                    "run workflow automation now",
                  );
                }}
              >
                {busy ? (
                  <IconLoader2 size={14} className="animate-spin" />
                ) : (
                  <IconPlayerPlay size={14} stroke={1.5} />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p className="text-xs">Run now</p>
            </TooltipContent>
          </Tooltip>
          {canEdit ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={busy}
                  aria-label="Edit automation"
                  className="h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:bg-gray-200 hover:text-foreground"
                  onClick={() => {
                    if (
                      automation.kind === "schedule" &&
                      automation.schedule.type === "cron"
                    ) {
                      setEditingScheduleCronFields(
                        parseWorkflowCronFields(
                          automation.schedule,
                          displayTimezone,
                        ),
                      );
                    }
                    setEditingAutomationId(automation.id);
                  }}
                >
                  <IconPencil size={14} stroke={1.5} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p className="text-xs">Edit automation</p>
              </TooltipContent>
            </Tooltip>
          ) : null}
          <AutomationMoreActionsMenu
            automation={automation}
            disabled={busy}
            onRevealWebhookSecret={
              isWebhookWorkflowAutomation(automation)
                ? () => {
                    setRevealWebhookSecretAutomationId(automation.id);
                  }
                : undefined
            }
          />
        </div>
      </TooltipProvider>
      {revealWebhookSecretOpen && isWebhookWorkflowAutomation(automation) ? (
        <RevealWebhookSecretDialog
          automation={automation}
          onOpenChange={(open) => {
            if (!open) {
              setRevealWebhookSecretAutomationId(null);
            }
          }}
        />
      ) : null}
    </div>
  );
}

function AutomationMoreActionsMenu({
  automation,
  disabled,
  onRevealWebhookSecret,
}: {
  readonly automation: ZeroWorkflowAutomationSummary;
  readonly disabled: boolean;
  readonly onRevealWebhookSecret?: () => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [deleteLoadable, deleteAutomation] = useLoadableSet(
    deleteWorkflowAutomation$,
  );
  const deleting = deleteLoadable.state === "loading";

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={disabled || deleting}
              aria-label="More actions"
              className="h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:bg-gray-200 hover:text-foreground data-[state=open]:bg-gray-200 data-[state=open]:text-foreground"
            >
              <IconDotsVertical size={14} stroke={1.5} />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <p className="text-xs">More actions</p>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-44">
        {onRevealWebhookSecret ? (
          <DropdownMenuModalItem
            disabled={deleting}
            className="gap-2"
            onModalSelect={onRevealWebhookSecret}
          >
            <IconEye size={14} stroke={1.5} />
            View webhook secret
          </DropdownMenuModalItem>
        ) : null}
        <DropdownMenuItem
          disabled={deleting}
          className="gap-2 text-destructive focus:text-destructive"
          onClick={() => {
            detach(
              deleteAutomation(automation.id, pageSignal),
              Reason.DomCallback,
            );
          }}
        >
          {deleting ? (
            <IconLoader2 size={14} className="animate-spin" />
          ) : (
            <IconTrash size={14} stroke={1.5} />
          )}
          Delete automation
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function canEditWorkflowAutomation(
  automation: ZeroWorkflowAutomationSummary,
): boolean {
  return (
    automation.kind === "schedule" ||
    isGmailWorkflowAutomation(automation) ||
    isGithubWorkflowAutomation(automation)
  );
}

function editWorkflowAutomationTitle(
  automation: ZeroWorkflowAutomationSummary,
): string {
  if (automation.kind === "schedule") {
    return "Edit schedule";
  }

  if (automation.eventType === "gmail-new-message") {
    return "Edit match";
  }
  if (automation.eventType === "github-workflow-run-completed") {
    return "Edit GitHub workflow filters";
  }
  if (isGithubWebhookWorkflowAutomation(automation)) {
    return `Edit ${githubWebhookAutomationTitle(automation.eventType)} filters`;
  }
  return "Edit label";
}

function EditWorkflowAutomationDialog({
  automation,
  displayTimezone,
  open,
  onOpenChange,
}: {
  readonly automation: ZeroWorkflowAutomationSummary;
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
        className={
          automation.kind === "event" &&
          (automation.eventType === "gmail-new-message" ||
            automation.eventType === "github-workflow-run-completed" ||
            isGithubWebhookWorkflowAutomation(automation))
            ? "max-w-2xl"
            : ""
        }
      >
        <DialogHeader>
          <DialogTitle>{editWorkflowAutomationTitle(automation)}</DialogTitle>
          <DialogDescription>Update this automation.</DialogDescription>
        </DialogHeader>
        {automation.kind === "schedule" ? (
          <UpdateScheduleAutomationForm
            automation={automation}
            displayTimezone={displayTimezone}
            onCancel={close}
          />
        ) : null}
        {automation.kind === "event" &&
        automation.eventType === "gmail-new-message" ? (
          <UpdateGmailNewMessageAutomationForm
            automation={automation}
            onCancel={close}
          />
        ) : null}
        {automation.kind === "event" &&
        automation.eventType === "gmail-label-applied" ? (
          <UpdateGmailLabelAppliedAutomationForm
            automation={automation}
            onCancel={close}
          />
        ) : null}
        {automation.kind === "event" &&
        automation.eventType === "github-label-applied" ? (
          <UpdateGithubLabelAppliedAutomationForm
            automation={automation}
            onCancel={close}
          />
        ) : null}
        {automation.kind === "event" &&
        automation.eventType === "github-workflow-run-completed" ? (
          <UpdateGithubWorkflowRunCompletedAutomationForm
            automation={automation}
            onCancel={close}
          />
        ) : null}
        {isGithubWebhookWorkflowAutomation(automation) ? (
          <UpdateGithubWebhookAutomationForm
            automation={automation}
            onCancel={close}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function UpdateScheduleAutomationForm({
  automation,
  displayTimezone,
  onCancel,
}: {
  readonly automation: Extract<
    ZeroWorkflowAutomationSummary,
    { kind: "schedule" }
  >;
  readonly displayTimezone: string;
  readonly onCancel: () => void;
}) {
  const cronFields = useGet(editingScheduleCronFields$);
  const setCronFields = useSet(setEditingScheduleCronFields$);
  const pageSignal = useGet(pageSignal$);
  const [updateLoadable, updateScheduleAutomation] = useLoadableSet(
    updateWorkflowScheduleAutomation$,
  );
  const saving = updateLoadable.state === "loading";
  const schedule = automation.schedule;

  return (
    <form
      aria-label="Update schedule automation"
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const scheduleValue = buildAutomationSchedule(
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
            await updateScheduleAutomation(
              {
                automationId: automation.id,
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
      <ScheduleAutomationFields
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

function UpdateGmailNewMessageAutomationForm({
  automation,
  onCancel,
}: {
  readonly automation: Extract<
    ZeroWorkflowAutomationSummary,
    { eventType: "gmail-new-message" }
  >;
  readonly onCancel: () => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [updateLoadable, updateGmailAutomation] = useLoadableSet(
    updateWorkflowGmailNewMessageAutomation$,
  );
  const matchConditionsByAutomationId = useGet(editingGmailMatchConditions$);
  const setMatchConditions = useSet(setEditingGmailMatchConditions$);
  const matchConditions =
    matchConditionsByAutomationId[automation.id] ??
    gmailMatchConditions(automation.eventConfig);
  const saving = updateLoadable.state === "loading";

  return (
    <form
      aria-label="Update Gmail new message automation"
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        detach(
          (async () => {
            await updateGmailAutomation(
              {
                automationId: automation.id,
                eventConfig: buildGmailNewMessageEventConfig(
                  form,
                  automation.eventConfig,
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
      <GmailMatchConditionsEditor
        conditions={matchConditions}
        disabled={saving}
        onChange={(conditions) => {
          setMatchConditions({ automationId: automation.id, conditions });
        }}
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
            <IconMail size={13} stroke={1.5} />
          )}
          <span>Save match</span>
        </Button>
      </DialogFooter>
    </form>
  );
}

function UpdateGmailLabelAppliedAutomationForm({
  automation,
  onCancel,
}: {
  readonly automation: Extract<
    ZeroWorkflowAutomationSummary,
    { eventType: "gmail-label-applied" }
  >;
  readonly onCancel: () => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [updateLoadable, updateGmailLabelAutomation] = useLoadableSet(
    updateWorkflowGmailLabelAppliedAutomation$,
  );
  const saving = updateLoadable.state === "loading";

  return (
    <form
      aria-label="Update Gmail label automation"
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
            await updateGmailLabelAutomation(
              {
                automationId: automation.id,
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
          defaultValue={automation.eventConfig.labelName}
          disabled={saving}
          placeholder="Support"
          className={AUTOMATION_FIELD_CLASS}
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

function UpdateGithubLabelAppliedAutomationForm({
  automation,
  onCancel,
}: {
  readonly automation: Extract<
    ZeroWorkflowAutomationSummary,
    { eventType: "github-label-applied" }
  >;
  readonly onCancel: () => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const githubLoadable = useLoadable(githubIntegrationData$);
  const githubData =
    githubLoadable.state === "hasData" ? githubLoadable.data : null;
  const editingGithubLabelActors = useGet(editingGithubLabelActors$);
  const setEditingGithubLabelActor = useSet(setEditingGithubLabelActor$);
  const actor =
    editingGithubLabelActors[automation.id] ??
    automation.eventConfig.filters.actor.type;
  const [updateLoadable, updateGithubLabelAutomation] = useLoadableSet(
    updateWorkflowGithubLabelAppliedAutomation$,
  );
  const [connectLoadable, connectGithub] = useLoadableSet(
    connectGithubInstallation$,
  );
  const saving = updateLoadable.state === "loading";
  const connecting = connectLoadable.state === "loading";
  const loadingGithub = githubLoadable.state === "loading";
  const githubLoadError = githubLoadable.state === "hasError";
  const isInstalled = githubData?.isInstalled ?? false;
  const needsConnection =
    isInstalled && actor === "me" && !githubData?.isConnected;
  const submitDisabled =
    saving ||
    loadingGithub ||
    githubLoadError ||
    !isInstalled ||
    needsConnection;
  const connectCurrentGithubAccount = () => {
    if (!githubData) {
      return;
    }
    detach(
      connectGithub(githubData.connectUrl, pageSignal),
      Reason.DomCallback,
    );
  };

  return (
    <form
      aria-label="Update GitHub label automation"
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const eventConfig = buildGithubLabelAppliedEventConfig(
          form,
          automation.eventConfig,
        );
        if (!eventConfig) {
          return;
        }
        detach(
          (async () => {
            await updateGithubLabelAutomation(
              {
                automationId: automation.id,
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
      <GithubLabelAutomationFields
        disabled={saving || loadingGithub || githubLoadError}
        actor={actor}
        defaultConfig={automation.eventConfig}
        onActorChange={(nextActor) => {
          setEditingGithubLabelActor({
            automationId: automation.id,
            actor: nextActor,
          });
        }}
      />
      <GithubLabelAutomationAvailabilityMessages
        githubLoaded={githubLoadable.state === "hasData"}
        isInstalled={isInstalled}
        needsConnection={needsConnection}
        githubLoadError={githubLoadError}
        connecting={connecting}
        onConnect={connectCurrentGithubAccount}
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
        <Button type="submit" disabled={submitDisabled}>
          {saving ? (
            <IconLoader2 size={13} className="animate-spin" />
          ) : (
            <IconBrandGithub size={13} stroke={1.5} />
          )}
          <span>Save label</span>
        </Button>
      </DialogFooter>
    </form>
  );
}

function UpdateGithubWorkflowRunCompletedAutomationForm({
  automation,
  onCancel,
}: {
  readonly automation: Extract<
    ZeroWorkflowAutomationSummary,
    { eventType: "github-workflow-run-completed" }
  >;
  readonly onCancel: () => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [updateLoadable, updateGithubWorkflowRunAutomation] = useLoadableSet(
    updateWorkflowGithubWorkflowRunCompletedAutomation$,
  );
  const saving = updateLoadable.state === "loading";
  return (
    <form
      aria-label="Update GitHub workflow automation"
      className="flex max-h-[75vh] flex-col gap-4 overflow-y-auto pr-1"
      onSubmit={(event) => {
        event.preventDefault();
        const eventConfig = buildGithubWorkflowRunCompletedEventConfig(
          new FormData(event.currentTarget),
        );
        detach(
          (async () => {
            await updateGithubWorkflowRunAutomation(
              {
                automationId: automation.id,
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
      <GithubWorkflowRunAutomationFields
        disabled={saving}
        defaultConfig={automation.eventConfig}
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
            <IconBrandGithub size={13} stroke={1.5} />
          )}
          <span>Save filters</span>
        </Button>
      </DialogFooter>
    </form>
  );
}

function UpdateGithubWebhookAutomationForm({
  automation,
  onCancel,
}: {
  readonly automation: GithubWebhookWorkflowAutomationSummary;
  readonly onCancel: () => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [updateLoadable, updateGithubWebhookAutomation] = useLoadableSet(
    updateWorkflowGithubWebhookAutomation$,
  );
  const saving = updateLoadable.state === "loading";
  return (
    <form
      aria-label={`Update ${githubWebhookAutomationTitle(automation.eventType)} automation`}
      className="flex max-h-[75vh] flex-col gap-4 overflow-y-auto pr-1"
      onSubmit={(event) => {
        event.preventDefault();
        const eventConfig = buildGithubWebhookEventConfig(
          automation.eventType,
          new FormData(event.currentTarget),
        );
        detach(
          (async () => {
            await updateGithubWebhookAutomation(
              { automationId: automation.id, eventConfig },
              pageSignal,
            );
            onCancel();
          })(),
          Reason.DomCallback,
        );
      }}
    >
      <GithubWebhookAutomationFields
        eventType={automation.eventType}
        disabled={saving}
        defaultConfig={automation.eventConfig}
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
            <IconBrandGithub size={13} stroke={1.5} />
          )}
          <span>Save filters</span>
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
