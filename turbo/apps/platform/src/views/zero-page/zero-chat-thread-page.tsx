import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";
import {
  useGet,
  useSet,
  useLastLoadable,
  useLastResolved,
  useLoadable,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import {
  IconAlertCircle,
  IconHandStop,
  IconPhoto,
  IconChartLine,
  IconPlayerPlay,
  IconPlayerStop,
  IconVideo,
  IconCopy,
  IconCheck,
  IconDots,
  IconVolume2,
  IconArrowDown,
  IconArrowRight,
  IconBrandGoogleDrive,
  IconChevronRight,
  IconDownload,
  IconFile,
  IconGitBranch,
  IconLink,
  IconLoader2,
  IconMessageCircle,
  IconPackage,
  IconTag,
  IconX,
} from "@tabler/icons-react";
import {
  cn,
  isEditableTarget,
  matchShortcut,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Skeleton,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui";
import { RUN_ERROR_GUIDANCE } from "@vm0/api-contracts/contracts/errors";
import type {
  ChatThreadArtifactFile,
  ChatThreadGithubPr,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { UserPermissionGrantResponse } from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import { isSupportedRunModel } from "@vm0/api-contracts/contracts/model-providers";
import emptyChatImg from "./assets/empty-chat.webp";
import emptyArtifactImg from "./assets/empty-artifact.webp";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  CONNECTOR_TYPES,
  type ConnectorAuthMethodIdsByGrantKind,
} from "@vm0/connectors/connectors";
import type { FirewallPolicyValue } from "@vm0/connectors/firewall-types";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { playTts$, stopTts$ } from "../../signals/voice-io/voice-io-tts.ts";
import {
  autoReadEnabled$,
  toggleAutoRead$,
} from "../../signals/voice-io/voice-io-settings.ts";
import { Markdown } from "../components/markdown.tsx";
import {
  detach,
  jsonParseOr,
  Reason,
  onDomEventFn,
} from "../../signals/utils.ts";
import {
  type ZeroClientFactory,
  zeroClient$,
} from "../../signals/api-client.ts";
import { accept } from "../../lib/accept.ts";
import {
  captureRecommendedFollowupSelected,
  captureRecommendedFollowupsShown,
} from "../../lib/posthog.ts";
import {
  AttachmentLightbox,
  CsvPreviewTable,
  downloadAttachmentUrl,
  FileAttachmentChip,
  getAttachmentRawUrl,
  parseCsvRows,
  PreviewableFileAttachmentChip,
  publicAttachmentUrl,
  TextPreviewLoader,
} from "./zero-attachment-chips.tsx";
import { ArtifactSidebarSlot } from "./zero-artifact-sidebar.tsx";
import {
  classifyChatAttachment,
  contentTypeForBodyPreviewKind,
  enrichBlocksWithTextPreviews,
  parseBodyRenderBlocks,
  type BodyRenderBlock,
} from "../../signals/chat-page/parse-body-blocks.ts";
import {
  activeChatConnectorAction$,
  closeChatConnectorActionConnectDialog$,
  completeChatConnectorActionConnect$,
  type ConnectorActionBlock,
} from "../../signals/chat-page/connector-action-block.ts";
import type { PermissionActionBlock } from "../../signals/chat-page/permission-action-block.ts";
import { AttachmentPreview } from "./zero-attachment-preview.tsx";
import { FilePreviewIcon } from "./zero-file-preview-icon.tsx";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import { ConnectModal } from "./components/settings/add-connection-dialog.tsx";
import { lightboxUrl$ as attachmentLightboxUrl$ } from "../../signals/zero-page/zero-attachment-chips.ts";
import {
  chatArtifactSidebarEnabled$,
  currentArtifactRef$,
  openDocumentLightboxOrArtifact$ as openAttachmentDocumentLightbox$,
  openImageLightboxOrArtifact$ as openAttachmentImageLightbox$,
  openVideoLightboxOrArtifact$ as openAttachmentVideoLightbox$,
} from "../../signals/zero-page/zero-artifact-sidebar.ts";
import {
  writeToClipboard,
  type ChatClipboardAttachment,
} from "../../signals/zero-page/clipboard.ts";
import { connectors$ } from "../../signals/external/connectors.ts";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  chatShortcutHelpOpen$,
  setChatShortcutHelpOpen$,
} from "../../signals/chat-page/chat-shortcut-help.ts";
import {
  agentGithubPrTrackingAvailable$,
  githubPrTrackingOpenThreadId$,
  chatThreadGithubPrs$,
  githubPrTrackingLabelOptions$,
  setGithubPrTrackingOpenThreadId$,
} from "../../signals/chat-page/github-pr-tracking.ts";
import { openQueueDrawer$ } from "../../signals/queue-page/queue-drawer-state.ts";
import { ShortcutHelpDialog } from "../components/shortcut-help-dialog.tsx";

import type {
  EnrichedChatMessage,
  GroupedChatMessageGroup,
  PagedChatMessage,
} from "../../signals/chat-page/chat-message.ts";
import type { ChatThreadSignals } from "../../signals/chat-page/create-chat-thread.ts";
import type { ChatThread } from "../../signals/agent-chat.ts";
import { ATTACH_ONLY_PLACEHOLDER } from "../../signals/chat-page/resolve-draft-attachments.ts";
import {
  ZeroChatComposer,
  type QueuedComposerItem,
} from "./zero-chat-composer.tsx";
import type { ModelProviderSelection } from "./components/model-provider-picker.tsx";
import { modelFirstPersonalOauthState$ } from "../../signals/zero-page/model-first-personal-oauth.ts";
import { updateUserModelPreference$ } from "../../signals/external/user-model-preference.ts";
import {
  resolveChatComposerSubmitBlocker,
  usePersonalOauthConfigurationAction,
} from "./model-first-oauth-submit-blocker.ts";
import { AgentAvatarImg } from "./zero-sidebar-shared.tsx";
import { Link } from "../router/link.tsx";
import { setOrgManageDialogOpen$ } from "../../signals/zero-page/settings/org-manage-dialog.ts";
import {
  setActiveOrgManageTab$,
  setBillingSubPage$,
} from "../../signals/zero-page/settings/org-manage-tabs-state.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import { agentById } from "../../signals/agent.ts";
import {
  extractPermissions,
  resolveUserPermissionGrantPolicy,
  upsertUserPermissionGrant$,
  userPermissionGrantsByAgent,
} from "../../signals/permission-allow/permission-allow-signals.ts";
import {
  billingStatusAsync$,
  type CreditCheckoutSelection,
  startCheckout$,
  startCreditCheckout$,
} from "../../signals/zero-page/billing.ts";
import {
  imageLoadStatusByKey$,
  imageLoadStatusRef$,
  setImageLoadStatus$,
} from "../../signals/view-component-state.ts";
import {
  currentLeftThread$,
  currentRightThread$,
} from "../../signals/chat-page/chat-thread-panes.ts";
import {
  navigateToAdjacentThread$,
  scrollCurrentThread$,
  setChatKeyboardScrollRoot$,
} from "../../signals/chat-page/chat-keyboard.ts";
import { sidebarChatThreads$ } from "../../signals/chat-page/optimistic-chat-thread-page.ts";
import {
  type ArtifactGoogleDriveSyncFile,
  syncArtifactFilesToGoogleDrive,
  syncArtifactFileToGoogleDrive,
  waitForGoogleDriveAndSyncArtifacts$,
} from "../../signals/chat-page/artifact-google-drive-sync.ts";
import { zeroConnectorOauthStartContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { createZipBlob } from "../../lib/zip.ts";
import { PersonalProviderDialog } from "./components/settings/personal-provider-dialog.tsx";
import { PersonalClaudeCodeDeviceAuthDialog } from "./components/settings/claude-code-device-auth-dialog.tsx";
import { PersonalCodexDeviceAuthDialog } from "./components/settings/codex-device-auth-dialog.tsx";

type RecommendedFollowup = NonNullable<
  Extract<PagedChatMessage, { role: "assistant" }>["recommendedFollowups"]
>[number];

const CONNECT_GOOGLE_DRIVE_ARTIFACT_UPLOAD_TOOLTIP =
  "Connect Google Drive to upload artifacts";
const GOOGLE_DRIVE_ARTIFACT_SYNC_AUTH_METHOD =
  "oauth" satisfies ConnectorAuthMethodIdsByGrantKind<
    "google-drive",
    "auth-code"
  >;

const CHAT_SHORTCUT_SECTIONS = [
  {
    title: "Global",
    shortcuts: [
      { key: "shift+/", label: "Show shortcuts" },
      { key: "mod+b", label: "Toggle sidebar" },
      { key: "mod+shift+o", label: "New chat" },
    ],
  },
  {
    title: "Messages",
    shortcuts: [
      { key: "mod+arrowup", label: "Scroll to top" },
      { key: "mod+arrowdown", label: "Scroll to bottom" },
      { key: "mod+shift+arrowup", label: "Previous thread" },
      { key: "mod+shift+arrowdown", label: "Next thread" },
    ],
  },
  {
    title: "Composer",
    shortcuts: [
      { key: "enter", label: "Send message" },
      { key: "escape", label: "Blur composer" },
    ],
  },
] as const;

function ArtifactsButton({ thread }: { thread: ChatThreadSignals }) {
  return <ArtifactsButtonInner thread={thread} />;
}

function ArtifactsButtonInner({ thread }: { thread: ChatThreadSignals }) {
  const open = useGet(thread.artifactsDrawerOpen$);
  const setOpen = useSet(thread.setArtifactsDrawerOpen$);

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => {
              setOpen(true);
            }}
            className={cn(
              "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors duration-150",
              open
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground/70 hover:bg-accent hover:text-foreground",
            )}
            aria-label="Open artifacts"
            aria-pressed={open}
          >
            <IconPackage size={17} stroke={1.5} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Open artifacts</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function githubPrRollupLabel(rollup: ChatThreadGithubPr["rollup"]): string {
  switch (rollup) {
    case "success": {
      return "Success";
    }
    case "failure": {
      return "Failed";
    }
    case "pending": {
      return "Pending";
    }
    case "none": {
      return "No actions";
    }
    case "unknown": {
      return "Unknown";
    }
  }
}

function githubPrRollupClassName(rollup: ChatThreadGithubPr["rollup"]): string {
  switch (rollup) {
    case "success": {
      return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
    }
    case "failure": {
      return "bg-destructive/10 text-destructive";
    }
    case "pending": {
      return "bg-amber-500/10 text-amber-700 dark:text-amber-400";
    }
    case "none": {
      return "bg-muted text-muted-foreground";
    }
    case "unknown": {
      return "bg-muted text-muted-foreground";
    }
  }
}

function githubPrMergeStatusLabel(
  mergeStatus: NonNullable<ChatThreadGithubPr["mergeStatus"]>,
): string {
  switch (mergeStatus) {
    case "ready": {
      return "Ready to merge";
    }
    case "conflicts": {
      return "Conflicts";
    }
    case "blocked": {
      return "Blocked";
    }
    case "draft": {
      return "Draft";
    }
  }
}

function githubPrMergeStatusClassName(
  mergeStatus: NonNullable<ChatThreadGithubPr["mergeStatus"]>,
): string {
  switch (mergeStatus) {
    case "ready": {
      return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
    }
    case "conflicts": {
      return "bg-destructive/10 text-destructive";
    }
    case "blocked": {
      return "bg-amber-500/10 text-amber-700 dark:text-amber-400";
    }
    case "draft": {
      return "bg-muted text-muted-foreground";
    }
  }
}

function githubPrStatusLabel(pr: ChatThreadGithubPr): string {
  if (pr.mergeStatus === "conflicts" || pr.mergeStatus === "draft") {
    return githubPrMergeStatusLabel(pr.mergeStatus);
  }
  if (pr.rollup === "failure" || pr.rollup === "pending") {
    return githubPrRollupLabel(pr.rollup);
  }
  if (pr.mergeStatus) {
    return githubPrMergeStatusLabel(pr.mergeStatus);
  }
  return githubPrRollupLabel(pr.rollup);
}

function githubPrStatusClassName(pr: ChatThreadGithubPr): string {
  if (pr.mergeStatus === "conflicts" || pr.mergeStatus === "draft") {
    return githubPrMergeStatusClassName(pr.mergeStatus);
  }
  if (pr.rollup === "failure" || pr.rollup === "pending") {
    return githubPrRollupClassName(pr.rollup);
  }
  if (pr.mergeStatus) {
    return githubPrMergeStatusClassName(pr.mergeStatus);
  }
  return githubPrRollupClassName(pr.rollup);
}

function githubPrStatusSortPriority(pr: ChatThreadGithubPr): number {
  if (pr.mergeStatus === "conflicts" || pr.rollup === "failure") {
    return 0;
  }
  if (pr.rollup === "pending" || pr.mergeStatus === "blocked") {
    return 1;
  }
  if (pr.mergeStatus === "draft") {
    return 2;
  }
  if (pr.rollup === "success" || pr.mergeStatus === "ready") {
    return 3;
  }
  return 4;
}

function sortGithubPrsByStatus(
  prs: readonly ChatThreadGithubPr[],
): readonly ChatThreadGithubPr[] {
  return prs
    .map((pr, index) => {
      return { pr, index };
    })
    .sort((left, right) => {
      const priorityDiff =
        githubPrStatusSortPriority(left.pr) -
        githubPrStatusSortPriority(right.pr);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }
      return left.index - right.index;
    })
    .map((entry) => {
      return entry.pr;
    });
}

function githubCheckResult(
  check: ChatThreadGithubPr["checks"][number],
): "success" | "failed" | "pending" {
  if (check.status !== "completed") {
    return "pending";
  }

  if (check.conclusion === "success") {
    return "success";
  }

  const failureConclusions = new Set([
    "failure",
    "timed_out",
    "action_required",
    "cancelled",
    "startup_failure",
    "stale",
  ]);
  if (check.conclusion && failureConclusions.has(check.conclusion)) {
    return "failed";
  }

  return "success";
}

function githubCheckResultLabel(
  result: ReturnType<typeof githubCheckResult>,
): string {
  switch (result) {
    case "success": {
      return "Success";
    }
    case "failed": {
      return "Failed";
    }
    case "pending": {
      return "Pending";
    }
  }
}

function githubCheckResultClassName(
  result: ReturnType<typeof githubCheckResult>,
): string {
  switch (result) {
    case "success": {
      return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
    }
    case "failed": {
      return "bg-destructive/10 text-destructive";
    }
    case "pending": {
      return "bg-amber-500/10 text-amber-700 dark:text-amber-400";
    }
  }
}

function githubCheckResultSortPriority(
  result: ReturnType<typeof githubCheckResult>,
): number {
  switch (result) {
    case "failed": {
      return 0;
    }
    case "pending": {
      return 1;
    }
    case "success": {
      return 2;
    }
  }
}

function sortGithubChecksByStatus(
  checks: readonly ChatThreadGithubPr["checks"][number][],
): readonly ChatThreadGithubPr["checks"][number][] {
  return checks
    .map((check, index) => {
      return { check, index };
    })
    .sort((left, right) => {
      const priorityDiff =
        githubCheckResultSortPriority(githubCheckResult(left.check)) -
        githubCheckResultSortPriority(githubCheckResult(right.check));
      if (priorityDiff !== 0) {
        return priorityDiff;
      }
      return left.index - right.index;
    })
    .map((entry) => {
      return entry.check;
    });
}

function githubCheckStatusText(
  check: ChatThreadGithubPr["checks"][number],
): string {
  if (check.status === "completed") {
    return check.conclusion ?? "completed";
  }
  return check.status;
}

function githubCheckTimeText(value: string | null): string {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function githubCheckRunKey(
  check: ChatThreadGithubPr["checks"][number],
): string {
  return [
    check.name,
    check.status,
    check.conclusion ?? "",
    check.url ?? "",
    check.startedAt ?? "",
    check.completedAt ?? "",
  ].join("|");
}

function GithubPrCheckRunRow({
  check,
}: {
  check: ChatThreadGithubPr["checks"][number];
}) {
  const statusText = githubCheckStatusText(check);
  const result = githubCheckResult(check);

  return (
    <details
      className="group rounded-md bg-muted/40 text-xs"
      title={check.name}
    >
      <summary className="flex w-full cursor-pointer list-none items-center gap-2 px-2 py-1.5 text-left [&::-webkit-details-marker]:hidden">
        <IconChevronRight
          size={13}
          className="shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
        />
        <span className="min-w-0 flex-1 truncate text-foreground">
          {check.name}
        </span>
        <span
          className={cn(
            "shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 font-medium",
            githubCheckResultClassName(result),
          )}
        >
          {githubCheckResultLabel(result)}
        </span>
      </summary>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-t border-border/60 px-2 py-2 text-muted-foreground">
        <dt className="whitespace-nowrap">Status</dt>
        <dd className="min-w-0 truncate whitespace-nowrap text-right text-foreground">
          {statusText}
        </dd>
        <dt className="whitespace-nowrap">Conclusion</dt>
        <dd className="min-w-0 truncate whitespace-nowrap text-right text-foreground">
          {check.conclusion ?? "-"}
        </dd>
        <dt className="whitespace-nowrap">Started</dt>
        <dd className="min-w-0 truncate whitespace-nowrap text-right text-foreground">
          {githubCheckTimeText(check.startedAt)}
        </dd>
        <dt className="whitespace-nowrap">Completed</dt>
        <dd className="min-w-0 truncate whitespace-nowrap text-right text-foreground">
          {githubCheckTimeText(check.completedAt)}
        </dd>
        {check.url && (
          <>
            <dt className="whitespace-nowrap">Link</dt>
            <dd className="min-w-0 text-right">
              <a
                href={check.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center justify-end gap-1 text-primary hover:underline"
              >
                <IconLink size={12} />
                Open action
              </a>
            </dd>
          </>
        )}
      </dl>
    </details>
  );
}

function GithubPrActions({
  pr,
  labelOptions,
  disabled,
  onPrompt,
}: {
  pr: ChatThreadGithubPr;
  labelOptions: readonly string[];
  disabled: boolean;
  onPrompt: (prompt: string) => void;
}) {
  const showFixConflict = pr.mergeStatus === "conflicts";
  const showLabels = labelOptions.length > 0;

  if (!showFixConflict && !showLabels) {
    return null;
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {showFixConflict && (
        <button
          type="button"
          disabled={disabled}
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-destructive/20 bg-destructive/5 px-2 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-60"
          onClick={() => {
            onPrompt(`fix pr ${pr.number} conflict & push`);
          }}
        >
          <IconGitBranch size={13} />
          Fix conflict
        </button>
      )}
      {showLabels && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs font-medium text-foreground hover:bg-accent disabled:pointer-events-none disabled:opacity-60"
              aria-label={`Add label to PR ${pr.number}`}
            >
              <IconTag size={13} />
              Add label
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="max-h-64 overflow-y-auto"
          >
            {labelOptions.map((labelName) => {
              return (
                <DropdownMenuItem
                  key={labelName}
                  onSelect={() => {
                    onPrompt(`add label "${labelName}" to pr ${pr.number}`);
                  }}
                >
                  {labelName}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function GithubPrTrackingSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading GitHub PR status"
      className="flex flex-col gap-3"
    >
      {[0, 1].map((cardIndex) => {
        return (
          <div
            key={cardIndex}
            className="rounded-md border border-border bg-background p-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-3 w-28 rounded" />
                <Skeleton className="h-4 w-[72%] rounded" />
              </div>
              <Skeleton className="h-5 w-20 shrink-0 rounded-full" />
            </div>
            <div className="mt-3 flex gap-2">
              <Skeleton className="h-7 w-24 rounded-md" />
              <Skeleton className="h-7 w-20 rounded-md" />
            </div>
            <div className="mt-3 flex flex-col gap-2">
              {[0, 1, 2].map((rowIndex) => {
                return (
                  <Skeleton key={rowIndex} className="h-8 w-full rounded-md" />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function GithubPrTrackingContent({ thread }: { thread: ChatThreadSignals }) {
  const githubPrs$ = chatThreadGithubPrs$(thread.threadId);
  const loadable = useLoadable(githubPrs$);
  const lastResolvedPrs = useLastResolved(githubPrs$);
  const labelsLoadable = useLastLoadable(githubPrTrackingLabelOptions$);
  const modelSelection = useLastResolved(thread.modelSelection$);
  const [sendActionLoadable, sendAction] = useLoadableSet(thread.sendMessage$);
  const rootSignal = useGet(rootSignal$);
  const labelOptions =
    labelsLoadable.state === "hasData" ? labelsLoadable.data : [];
  const actionDisabled =
    sendActionLoadable.state === "loading" || modelSelection === undefined;
  const sendPrompt = (prompt: string) => {
    if (modelSelection === undefined) {
      return;
    }
    detach(
      sendAction(prompt, modelSelection, undefined, rootSignal),
      Reason.DomCallback,
    );
  };
  const prs = loadable.state === "hasData" ? loadable.data : lastResolvedPrs;

  if (loadable.state === "loading" && prs === undefined) {
    return <GithubPrTrackingSkeleton />;
  }

  if (loadable.state === "hasError" && prs === undefined) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">
        <IconAlertCircle size={16} className="mt-0.5 shrink-0" />
        Failed to load GitHub PR status.
      </div>
    );
  }

  if (prs === undefined) {
    return null;
  }

  if (prs.length === 0) {
    return (
      <div className="rounded-md border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        No GitHub PRs found in this chat.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {sortGithubPrsByStatus(prs).map((pr) => {
        const sortedChecks = sortGithubChecksByStatus(pr.checks);
        return (
          <div
            key={`${pr.repo}#${pr.number}`}
            className="rounded-md border border-border bg-background p-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground">
                  {pr.repo} #{pr.number}
                </div>
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 line-clamp-2 text-sm font-medium text-foreground hover:underline"
                >
                  {pr.title}
                </a>
              </div>
              <span
                className={cn(
                  "shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",
                  githubPrStatusClassName(pr),
                )}
              >
                {githubPrStatusLabel(pr)}
              </span>
            </div>
            <GithubPrActions
              pr={pr}
              labelOptions={labelOptions}
              disabled={actionDisabled}
              onPrompt={sendPrompt}
            />
            <div className="mt-3 flex flex-col gap-2">
              {sortedChecks.length === 0 ? (
                <div className="text-xs text-muted-foreground">
                  No GitHub Actions checks.
                </div>
              ) : (
                <div className="flex max-h-72 flex-col gap-2 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
                  {sortedChecks.map((check) => {
                    return (
                      <GithubPrCheckRunRow
                        key={githubCheckRunKey(check)}
                        check={check}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function GithubPrTrackingButton({
  thread,
  agentId,
}: {
  thread: ChatThreadSignals;
  agentId: string;
}) {
  const availableLoadable = useLastLoadable(
    agentGithubPrTrackingAvailable$(agentId),
  );
  const openThreadId = useGet(githubPrTrackingOpenThreadId$);
  const setOpenThreadId = useSet(setGithubPrTrackingOpenThreadId$);
  const pageSignal = useGet(pageSignal$);
  const open = openThreadId === thread.threadId;

  if (
    availableLoadable.state !== "hasData" ||
    availableLoadable.data !== true
  ) {
    return null;
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => {
              if (open) {
                setOpenThreadId(null);
                return;
              }
              setOpenThreadId(thread.threadId, pageSignal);
            }}
            className={cn(
              "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors duration-150",
              open
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground/70 hover:bg-accent hover:text-foreground",
            )}
            aria-label="Open GitHub PR tracking"
            aria-pressed={open}
          >
            <IconGitBranch size={18} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Track GitHub PRs</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function GithubPrTrackingDock({ thread }: { thread: ChatThreadSignals }) {
  const setOpenThreadId = useSet(setGithubPrTrackingOpenThreadId$);

  return (
    <aside
      aria-label="GitHub PR tracking"
      className="pointer-events-none absolute inset-y-0 right-0 z-20 flex px-3 pt-3"
      style={{
        width: `var(--github-pr-tracking-dock-width, ${GITHUB_PR_TRACKING_DOCK_WIDTH})`,
        paddingBottom: "calc(max(0.5rem, var(--sab)) + 0.5rem)",
      }}
    >
      <div className="pointer-events-auto flex min-h-0 w-full flex-col rounded-lg border border-border bg-background shadow-sm">
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-foreground">
              GitHub PRs
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Pull requests mentioned in this chat thread.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close GitHub PR tracking"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => {
              setOpenThreadId(null);
            }}
          >
            <IconX size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <GithubPrTrackingContent thread={thread} />
        </div>
      </div>
    </aside>
  );
}

function ChatThreadHeader({ thread }: { thread: ChatThreadSignals }) {
  const threadDataLoadable = useLastLoadable(thread.threadData$);
  const autoRead = useGet(autoReadEnabled$);
  const toggleAutoReadFn = useSet(toggleAutoRead$);
  const features = useLastResolved(featureSwitch$);
  const audioOutputEnabled = features?.[FeatureSwitchKey.AudioOutput] ?? false;
  const githubPrTrackingEnabled =
    features?.[FeatureSwitchKey.ChatGithubPrTracking] ?? false;
  const agentId =
    threadDataLoadable.state === "hasData"
      ? (threadDataLoadable.data?.agentId ?? null)
      : null;
  const threadTitle =
    threadDataLoadable.state === "hasData"
      ? (threadDataLoadable.data?.title?.trim() ?? "")
      : "";

  return (
    <header className="hidden sm:flex shrink-0 bg-transparent px-6 py-3 items-center justify-between">
      <div className="flex items-center gap-3">
        {threadDataLoadable.state === "loading" ? (
          <Skeleton className="h-5 w-48 rounded" />
        ) : (
          <span className="min-w-0 truncate text-sm font-medium text-foreground">
            {threadTitle}
          </span>
        )}
      </div>
      <div className="hidden sm:flex items-center gap-0.5">
        <ArtifactsButton thread={thread} />
        {githubPrTrackingEnabled && agentId && (
          <GithubPrTrackingButton thread={thread} agentId={agentId} />
        )}
        {audioOutputEnabled && (
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => {
                    toggleAutoReadFn();
                  }}
                  className={cn(
                    "p-1.5 rounded-md transition-colors duration-150",
                    autoRead
                      ? "text-primary bg-primary/10"
                      : "text-muted-foreground/60 hover:text-foreground hover:bg-accent",
                  )}
                  aria-label="Toggle auto-read"
                  aria-pressed={autoRead}
                >
                  <IconVolume2 size={18} stroke={1.5} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {autoRead ? "Auto-read on" : "Auto-read off"}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
    </header>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1024;
  for (let i = 0; i < units.length; i++) {
    const unit = units[i]!;
    if (value < 1024 || i === units.length - 1) {
      return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
    }
    value = value / 1024;
  }
  return `${bytes} B`;
}

function formatArtifactTime(value: string): string {
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

type ChatArtifactItem = {
  runId: string;
  file: ChatThreadArtifactFile;
};

type ArtifactPreviewKind = "image" | "video" | "audio" | "document" | "file";

function artifactItemKey(item: ChatArtifactItem): string {
  return `${item.runId}:${item.file.id}:${item.file.url}`;
}

function getArtifactPreviewKind(
  file: ChatThreadArtifactFile,
): ArtifactPreviewKind {
  const kind = classifyChatAttachment({
    filename: file.filename,
    url: file.url,
    contentType: file.contentType,
  });

  if (kind === "image") {
    return "image";
  }
  if (kind === "video") {
    return "video";
  }
  if (kind === "audio") {
    return "audio";
  }
  if (
    kind === "markdown" ||
    kind === "text" ||
    kind === "json" ||
    kind === "csv" ||
    kind === "pdf" ||
    kind === "html"
  ) {
    return "document";
  }
  return "file";
}

function flattenArtifactRuns(
  runs: { runId: string; files: ChatThreadArtifactFile[] }[],
): ChatArtifactItem[] {
  return runs.flatMap((run) => {
    return run.files.map((file) => {
      return { runId: run.runId, file };
    });
  });
}

function ArtifactFileIcon({
  file,
  size = "sm",
}: {
  file: ChatThreadArtifactFile;
  size?: "sm" | "md";
}) {
  return (
    <FilePreviewIcon
      filename={file.filename}
      contentType={file.contentType}
      size={size}
      testId="artifact-file-icon"
    />
  );
}

function ArtifactPreviewBadge({ file }: { file: ChatThreadArtifactFile }) {
  if (getArtifactPreviewKind(file) === "image") {
    return (
      <img
        src={file.url}
        alt=""
        aria-hidden="true"
        className="h-full w-full object-cover"
      />
    );
  }

  return <ArtifactFileIcon file={file} />;
}

type ArtifactTextPreviewKind = "markdown" | "text" | "json" | "csv";
type ArtifactDocumentPreviewKind = ArtifactTextPreviewKind | "pdf" | "html";

function getArtifactTextPreviewKind(
  file: ChatThreadArtifactFile,
): ArtifactTextPreviewKind | null {
  const kind = classifyChatAttachment({
    filename: file.filename,
    url: file.url,
    contentType: file.contentType,
  });

  if (
    kind === "markdown" ||
    kind === "text" ||
    kind === "json" ||
    kind === "csv"
  ) {
    return kind;
  }

  if (/\.log$/i.test(file.filename)) {
    return "text";
  }

  return null;
}

function formatArtifactTextPreview(
  kind: Exclude<ArtifactTextPreviewKind, "markdown">,
  text: string,
): string {
  if (kind === "json") {
    const parsed = jsonParseOr<unknown>(text, null);
    return parsed === null ? text : JSON.stringify(parsed, null, 2);
  }
  return text;
}

function getArtifactDocumentPreviewKind(
  file: ChatThreadArtifactFile,
): ArtifactDocumentPreviewKind | null {
  const textKind = getArtifactTextPreviewKind(file);
  if (textKind) {
    return textKind;
  }

  const contentType = file.contentType.toLowerCase();
  const filename = file.filename.toLowerCase();
  if (contentType === "application/pdf" || filename.endsWith(".pdf")) {
    return "pdf";
  }
  if (
    contentType === "text/html" ||
    filename.endsWith(".html") ||
    filename.endsWith(".htm")
  ) {
    return "html";
  }

  return null;
}

function ArtifactTextDocumentPreviewFrame({
  file,
  kind,
}: {
  file: ChatThreadArtifactFile;
  kind: ArtifactTextPreviewKind;
}) {
  const pageSignal = useGet(pageSignal$);

  return (
    <TextPreviewLoader url={file.url} signal={pageSignal}>
      {({ status, text }) => {
        if (status === "loading") {
          return (
            <div className="flex h-full w-full items-center justify-center bg-muted/40 text-muted-foreground">
              <IconLoader2 size={18} className="animate-spin" />
            </div>
          );
        }

        if (status === "error") {
          return (
            <div className="flex h-full w-full items-center justify-center bg-muted/40 px-6 text-center text-sm text-muted-foreground">
              {kind === "markdown"
                ? "Markdown"
                : kind === "json"
                  ? "JSON"
                  : kind === "csv"
                    ? "CSV"
                    : "Text"}{" "}
              preview unavailable.
            </div>
          );
        }

        if (kind === "csv") {
          const rows = parseCsvRows(text);
          if (rows.length === 0) {
            return (
              <div className="flex h-full w-full items-center justify-center bg-muted/40 px-6 text-center text-sm text-muted-foreground">
                CSV preview unavailable.
              </div>
            );
          }

          return (
            <div className="h-full w-full overflow-auto bg-background p-4">
              <CsvPreviewTable rows={rows} />
            </div>
          );
        }

        if (kind !== "markdown") {
          const display = formatArtifactTextPreview(kind, text);
          return (
            <div className="h-full w-full overflow-auto bg-background p-4">
              <pre className="whitespace-pre-wrap break-words text-xs text-foreground">
                {display.length > 16_000
                  ? `${display.slice(0, 16_000)}\n\n…`
                  : display}
              </pre>
            </div>
          );
        }

        return (
          <div className="h-full w-full overflow-auto bg-background p-4 text-sm">
            <Markdown source={text} />
          </div>
        );
      }}
    </TextPreviewLoader>
  );
}

function ArtifactPreviewOpenOverlay({
  children,
  filename,
  onOpen,
}: {
  children: ReactNode;
  filename: string;
  onOpen: () => void;
}) {
  const lightboxOpen = useGet(attachmentLightboxUrl$) !== null;

  return (
    <div className="group/artifact-preview relative h-full w-full">
      {children}
      <button
        type="button"
        onClick={(event) => {
          event.currentTarget.blur();
          onOpen();
        }}
        disabled={lightboxOpen}
        aria-label={`Open preview for ${filename}`}
        className={cn(
          "absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/80",
          lightboxOpen
            ? "pointer-events-none"
            : "group-hover/artifact-preview:bg-black/30 group-hover/artifact-preview:opacity-100 group-focus-within/artifact-preview:bg-black/30 group-focus-within/artifact-preview:opacity-100",
        )}
      >
        <span className="flex h-16 w-16 items-center justify-center rounded-lg text-white">
          <IconFile
            size={24}
            stroke={1.8}
            className="drop-shadow transition-opacity"
          />
        </span>
      </button>
    </div>
  );
}

async function copyArtifactLinkToClipboard(
  file: ChatThreadArtifactFile,
): Promise<void> {
  const copied = await writeToClipboard(publicAttachmentUrl(file.url));
  if (copied) {
    toast.success("Link copied");
    return;
  }
  toast.error("Failed to copy link");
}

async function downloadArtifactItemsAsZip(params: {
  readonly items: readonly ChatArtifactItem[];
  readonly signal: AbortSignal;
  readonly threadId: string;
}): Promise<void> {
  const toastId = toast.loading(`Preparing ${params.items.length} files...`);
  // eslint-disable-next-line no-restricted-syntax -- zip download must replace the loading toast on success or failure
  try {
    const entries = await Promise.all(
      params.items.map((item) => {
        return fetchArtifactZipEntry(item, params.signal);
      }),
    );
    const zip = createZipBlob(entries);
    triggerArtifactZipDownload(zip, `vm0-artifact-${params.threadId}.zip`);
    toast.success("Downloaded artifacts", { id: toastId });
  } catch (error) {
    params.signal.throwIfAborted();
    toast.error(
      error instanceof Error
        ? error.message
        : "Failed to prepare artifact download",
      { id: toastId },
    );
  }
}

async function fetchArtifactZipEntry(
  item: ChatArtifactItem,
  signal: AbortSignal,
): Promise<{
  readonly filename: string;
  readonly data: ArrayBuffer;
  readonly modifiedAt: Date;
}> {
  const response = await fetch(getAttachmentRawUrl(item.file.url), {
    mode: "cors",
    signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to download ${item.file.filename}`);
  }
  const data = await response.arrayBuffer();
  return {
    filename: item.file.filename,
    data,
    modifiedAt: new Date(item.file.createdAt),
  };
}

function triggerArtifactZipDownload(blob: Blob, filename: string): void {
  const blobUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(blobUrl);
}

function artifactItemsToGoogleDriveFiles(
  items: readonly ChatArtifactItem[],
): ArtifactGoogleDriveSyncFile[] {
  return items.map((item) => {
    return {
      runId: item.runId,
      fileId: item.file.id,
      filename: item.file.filename,
    };
  });
}

function isArtifactSyncedToGoogleDrive(item: ChatArtifactItem): boolean {
  return item.file.googleDriveSync?.status === "synced";
}

type WaitForGoogleDriveAndSyncArtifactsFn = (
  params: {
    readonly agentId: string;
    readonly threadId: string;
    readonly files: readonly ArtifactGoogleDriveSyncFile[];
  },
  signal: AbortSignal,
) => Promise<unknown>;

function startGoogleDriveConnectAndSync(params: {
  agentId: string | null | undefined;
  createClient: ZeroClientFactory;
  files: readonly ArtifactGoogleDriveSyncFile[];
  pageSignal: AbortSignal;
  threadId: string;
  waitForGoogleDriveAndSyncArtifacts: WaitForGoogleDriveAndSyncArtifactsFn;
  onSyncComplete: () => void;
}): void {
  if (params.files.length === 0) {
    return;
  }
  if (!params.agentId) {
    toast.error("Agent is still loading");
    return;
  }
  const authWindow = window.open(
    "about:blank",
    "_blank",
    "width=600,height=700",
  );
  if (!authWindow) {
    toast.error("Failed to open Google Drive connection page");
    return;
  }
  const agentId = params.agentId;
  detach(
    (async () => {
      const client = params.createClient(zeroConnectorOauthStartContract, {
        apiBase: "www",
      });
      const result = await accept(
        client.start({
          params: { type: "google-drive" },
          body: { authMethod: GOOGLE_DRIVE_ARTIFACT_SYNC_AUTH_METHOD },
          fetchOptions: { signal: params.pageSignal },
        }),
        [200],
      );
      params.pageSignal.throwIfAborted();
      authWindow.location.href = result.body.authorizationUrl;
    })(),
    Reason.DomCallback,
    "artifact google drive oauth start",
  );
  detach(
    (async () => {
      await params.waitForGoogleDriveAndSyncArtifacts(
        {
          agentId,
          threadId: params.threadId,
          files: params.files,
        },
        params.pageSignal,
      );
      params.onSyncComplete();
    })(),
    Reason.DomCallback,
    "artifact google drive connect sync",
  );
}

function syncArtifactFilesAndRefresh(params: {
  sync: Promise<boolean>;
  onSyncSuccess: () => void;
  reason: string;
}): void {
  detach(
    (async () => {
      const success = await params.sync;
      if (success) {
        params.onSyncSuccess();
      }
    })(),
    Reason.DomCallback,
    params.reason,
  );
}

function ArtifactGoogleDriveConnectMenuItem({
  agentId,
  files,
  label,
  onSyncComplete,
  threadId,
}: {
  agentId: string | null | undefined;
  files: readonly ArtifactGoogleDriveSyncFile[];
  label: string;
  onSyncComplete: () => void;
  threadId: string;
}) {
  const waitForGoogleDriveAndSyncArtifacts = useSet(
    waitForGoogleDriveAndSyncArtifacts$,
  );
  const createClient = useGet(zeroClient$);
  const pageSignal = useGet(pageSignal$);

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuItem
            className="text-muted-foreground"
            title={CONNECT_GOOGLE_DRIVE_ARTIFACT_UPLOAD_TOOLTIP}
            onClick={() => {
              startGoogleDriveConnectAndSync({
                agentId,
                createClient,
                files,
                pageSignal,
                threadId,
                waitForGoogleDriveAndSyncArtifacts,
                onSyncComplete,
              });
            }}
          >
            <IconBrandGoogleDrive size={14} stroke={1.5} />
            {label}
          </DropdownMenuItem>
        </TooltipTrigger>
        <TooltipContent side="left">
          {CONNECT_GOOGLE_DRIVE_ARTIFACT_UPLOAD_TOOLTIP}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ArtifactPreviewIconButton({
  ariaLabel,
  children,
  disabled = false,
  onClick,
  tooltip,
}: {
  ariaLabel: string;
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
  tooltip: string;
}) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-disabled={disabled}
            aria-label={ariaLabel}
            onClick={() => {
              if (!disabled) {
                onClick();
              }
            }}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              disabled &&
                "cursor-not-allowed opacity-45 hover:bg-transparent hover:text-muted-foreground",
            )}
          >
            {children}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p className="text-xs">{tooltip}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ArtifactPreviewActions({
  item,
  googleDriveConnected,
  agentId,
  threadId,
  onSyncSuccess,
}: {
  item: ChatArtifactItem;
  googleDriveConnected: boolean;
  agentId: string | null | undefined;
  threadId: string;
  onSyncSuccess: () => void;
}) {
  const createClient = useGet(zeroClient$);
  const waitForGoogleDriveAndSyncArtifacts = useSet(
    waitForGoogleDriveAndSyncArtifacts$,
  );
  const pageSignal = useGet(pageSignal$);
  const { file } = item;
  const synced = isArtifactSyncedToGoogleDrive(item);
  const syncTooltip = synced
    ? "Synced to Google Drive"
    : googleDriveConnected
      ? "Sync to Google Drive"
      : CONNECT_GOOGLE_DRIVE_ARTIFACT_UPLOAD_TOOLTIP;
  const syncAriaLabel = synced
    ? `${file.filename} is synced to Google Drive`
    : `Sync ${file.filename} to Google Drive`;

  return (
    <div className="flex shrink-0 items-center gap-1">
      <ArtifactPreviewIconButton
        ariaLabel={`Copy link for ${file.filename}`}
        tooltip="Copy link"
        onClick={() => {
          detach(
            copyArtifactLinkToClipboard(file),
            Reason.DomCallback,
            "artifact copy link",
          );
        }}
      >
        <IconLink size={16} stroke={1.5} />
      </ArtifactPreviewIconButton>
      <ArtifactPreviewIconButton
        ariaLabel={`Download ${file.filename}`}
        tooltip="Download"
        onClick={() => {
          detach(
            downloadAttachmentUrl(file.url, pageSignal, file.filename),
            Reason.DomCallback,
            "artifact download",
          );
        }}
      >
        <IconDownload size={16} stroke={1.5} />
      </ArtifactPreviewIconButton>
      <ArtifactPreviewIconButton
        ariaLabel={syncAriaLabel}
        disabled={synced}
        tooltip={syncTooltip}
        onClick={() => {
          if (googleDriveConnected) {
            syncArtifactFilesAndRefresh({
              sync: syncArtifactFileToGoogleDrive({
                createClient,
                threadId,
                runId: item.runId,
                fileId: item.file.id,
                filename: item.file.filename,
                signal: pageSignal,
              }),
              onSyncSuccess,
              reason: "artifact google drive sync",
            });
            return;
          }
          startGoogleDriveConnectAndSync({
            agentId,
            createClient,
            files: artifactItemsToGoogleDriveFiles([item]),
            pageSignal,
            threadId,
            waitForGoogleDriveAndSyncArtifacts,
            onSyncComplete: onSyncSuccess,
          });
        }}
      >
        <IconBrandGoogleDrive size={16} stroke={1.5} />
      </ArtifactPreviewIconButton>
    </div>
  );
}

function ArtifactBulkActionsMenu({
  items,
  googleDriveConnected,
  agentId,
  onSyncSuccess,
  threadId,
}: {
  items: readonly ChatArtifactItem[];
  googleDriveConnected: boolean;
  agentId: string | null | undefined;
  onSyncSuccess: () => void;
  threadId: string;
}) {
  const createClient = useGet(zeroClient$);
  const pageSignal = useGet(pageSignal$);
  const syncableItems = items.filter((item) => {
    return !isArtifactSyncedToGoogleDrive(item);
  });
  const files = artifactItemsToGoogleDriveFiles(syncableItems);
  const allSynced = items.length > 0 && files.length === 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label="More artifact actions"
        >
          <IconDots size={15} stroke={1.5} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem
          onClick={() => {
            detach(
              downloadArtifactItemsAsZip({
                items,
                signal: pageSignal,
                threadId,
              }),
              Reason.DomCallback,
              "artifact download all",
            );
          }}
        >
          <IconDownload size={14} stroke={1.5} />
          Download all
        </DropdownMenuItem>
        {googleDriveConnected ? (
          <DropdownMenuItem
            disabled={allSynced}
            onClick={() => {
              syncArtifactFilesAndRefresh({
                sync: syncArtifactFilesToGoogleDrive({
                  createClient,
                  threadId,
                  files,
                  signal: pageSignal,
                }),
                onSyncSuccess,
                reason: "artifact google drive sync all",
              });
            }}
          >
            <IconBrandGoogleDrive size={14} stroke={1.5} />
            {allSynced
              ? "Synced all to Google Drive"
              : "Sync all to Google Drive"}
          </DropdownMenuItem>
        ) : (
          <ArtifactGoogleDriveConnectMenuItem
            agentId={agentId}
            files={files}
            label="Sync all to Google Drive"
            onSyncComplete={onSyncSuccess}
            threadId={threadId}
          />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type ChatImagePreviewLinkProps = {
  alt: string;
  ariaLabel: string;
  imageClassName: string;
  linkClassName: string;
  onPreview: () => void;
  placeholderClassName: string;
  url: string;
};

function ChatImagePreviewLink({
  alt,
  ariaLabel,
  imageClassName,
  linkClassName,
  onPreview,
  placeholderClassName,
  url,
}: ChatImagePreviewLinkProps) {
  const imageLoadStatuses = useGet(imageLoadStatusByKey$);
  const imageLoadStatusRef = useSet(imageLoadStatusRef$);
  const setImageLoadStatus = useSet(setImageLoadStatus$);
  const imageUrl = publicAttachmentUrl(url);
  const imageLoadKey = `chat-image-preview:${imageUrl}`;
  const imageStatus = imageLoadStatuses[imageLoadKey] ?? "loading";

  const showPlaceholder = imageStatus !== "loaded";

  const openPreview = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.button !== 0
    ) {
      return;
    }
    event.preventDefault();
    onPreview();
  };

  return (
    <a
      href={imageUrl}
      onClick={openPreview}
      className={cn(
        "group/image-preview relative inline-block overflow-hidden",
        linkClassName,
      )}
      aria-label={ariaLabel}
    >
      {showPlaceholder && (
        <span
          data-testid="chat-image-preview-loading"
          className={cn(
            "flex items-center justify-center bg-muted/70 text-muted-foreground",
            placeholderClassName,
          )}
        >
          {imageStatus === "loading" ? (
            <IconLoader2 size={18} stroke={1.8} className="animate-spin" />
          ) : (
            <IconPhoto size={18} stroke={1.5} />
          )}
        </span>
      )}
      <img
        key={imageLoadKey}
        ref={imageLoadStatusRef}
        src={imageUrl}
        alt={alt}
        data-image-load-key={imageLoadKey}
        loading="lazy"
        onLoad={() => {
          setImageLoadStatus(imageLoadKey, "loaded");
        }}
        onError={() => {
          setImageLoadStatus(imageLoadKey, "error");
        }}
        className={cn(
          imageClassName,
          showPlaceholder && "absolute inset-0 opacity-0",
        )}
      />
      <span className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all duration-150 group-hover/image-preview:bg-black/30 group-hover/image-preview:opacity-100">
        <IconPhoto
          size={18}
          className="text-white opacity-0 drop-shadow transition-opacity group-hover/image-preview:opacity-100"
        />
      </span>
    </a>
  );
}

type ChatVideoPreviewButtonProps = {
  ariaLabel: string;
  buttonClassName: string;
  filename: string;
  onPreview: () => void;
  posterClassName: string;
  url: string;
  videoClassName: string;
};

function videoPosterFrameUrl(url: string): string {
  const hashIndex = url.indexOf("#");
  const urlWithoutHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
  return `${urlWithoutHash}#t=0.001`;
}

function ChatVideoPreviewButton({
  ariaLabel,
  buttonClassName,
  filename,
  onPreview,
  posterClassName,
  url,
  videoClassName,
}: ChatVideoPreviewButtonProps) {
  const videoUrl = publicAttachmentUrl(url);
  const posterVideoUrl = videoPosterFrameUrl(videoUrl);

  return (
    <button
      type="button"
      onClick={onPreview}
      title={filename}
      aria-label={ariaLabel}
      className={cn(
        "group/video-preview relative overflow-hidden bg-black",
        buttonClassName,
      )}
    >
      <span
        data-testid="chat-video-preview-poster"
        className={cn(
          "flex items-center justify-center bg-black text-white/70",
          posterClassName,
        )}
      >
        <IconVideo size={22} stroke={1.5} />
      </span>
      <video
        src={posterVideoUrl}
        preload="metadata"
        muted
        playsInline
        aria-hidden="true"
        className={cn("absolute inset-0", videoClassName)}
      />
      <span className="absolute inset-0 flex items-center justify-center bg-black/10 transition-colors group-hover/video-preview:bg-black/35">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-black/55 text-white shadow-lg transition-transform group-hover/video-preview:scale-105">
          <IconPlayerPlay size={17} stroke={1.8} />
        </span>
      </span>
    </button>
  );
}

function ArtifactPreviewFrame({ file }: { file: ChatThreadArtifactFile }) {
  const openImageLightbox = useSet(openAttachmentImageLightbox$);
  const openDocumentLightbox = useSet(openAttachmentDocumentLightbox$);
  const openVideoLightbox = useSet(openAttachmentVideoLightbox$);
  const previewKind = getArtifactPreviewKind(file);

  if (previewKind === "image") {
    return (
      <ChatImagePreviewLink
        alt={`Preview ${file.filename}`}
        ariaLabel={`Preview ${file.filename}`}
        imageClassName="h-full w-full object-contain"
        linkClassName="flex h-full w-full items-center justify-center bg-muted"
        onPreview={() => {
          openImageLightbox(file.url);
        }}
        placeholderClassName="h-full w-full"
        url={file.url}
      />
    );
  }

  if (previewKind === "video") {
    return (
      <ChatVideoPreviewButton
        ariaLabel={`Preview ${file.filename}`}
        buttonClassName="flex h-full w-full items-center justify-center"
        filename={file.filename}
        onPreview={() => {
          openVideoLightbox({
            url: file.url,
            filename: file.filename,
          });
        }}
        posterClassName="h-full w-full"
        url={file.url}
        videoClassName="h-full w-full object-contain"
      />
    );
  }

  if (previewKind === "audio") {
    return (
      <div className="flex h-full w-full items-center justify-center bg-muted/40 px-8">
        <audio
          src={file.url}
          controls
          preload="metadata"
          className="w-full max-w-[480px]"
          aria-label={`Audio preview for ${file.filename}`}
        />
      </div>
    );
  }

  if (previewKind === "document") {
    const documentPreviewKind = getArtifactDocumentPreviewKind(file);
    if (!documentPreviewKind) {
      return (
        <div className="flex h-full w-full items-center justify-center bg-muted/40">
          <ArtifactFileIcon file={file} size="md" />
        </div>
      );
    }

    const openPreview = () => {
      openDocumentLightbox({
        kind: documentPreviewKind,
        url: file.url,
        filename: file.filename,
      });
    };

    if (documentPreviewKind !== "pdf" && documentPreviewKind !== "html") {
      return (
        <ArtifactPreviewOpenOverlay
          filename={file.filename}
          onOpen={openPreview}
        >
          <ArtifactTextDocumentPreviewFrame
            file={file}
            kind={documentPreviewKind}
          />
        </ArtifactPreviewOpenOverlay>
      );
    }

    return (
      <ArtifactPreviewOpenOverlay filename={file.filename} onOpen={openPreview}>
        <iframe
          src={file.url}
          title={`Preview ${file.filename}`}
          className="h-full w-full bg-background"
        />
      </ArtifactPreviewOpenOverlay>
    );
  }

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-muted/40 p-8 text-center">
      <span className="flex h-16 w-16 items-center justify-center rounded-lg border border-border/70 bg-background text-muted-foreground shadow-sm">
        <ArtifactFileIcon file={file} size="md" />
      </span>
      <div className="min-w-0">
        <p className="max-w-[260px] truncate text-sm text-foreground">
          {file.filename}
        </p>
      </div>
    </div>
  );
}

function ArtifactPreviewPanel({
  item,
  googleDriveConnected,
  agentId,
  onSyncSuccess,
  threadId,
}: {
  item: ChatArtifactItem;
  googleDriveConnected: boolean;
  agentId: string | null | undefined;
  onSyncSuccess: () => void;
  threadId: string;
}) {
  const { file } = item;

  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-border/70 bg-background shadow-sm">
      <div className="h-[260px] border-b border-border/60 bg-muted/30">
        <ArtifactPreviewFrame file={file} />
      </div>
      <div className="flex items-start gap-3 px-3 py-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground">
          <ArtifactPreviewBadge file={file} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">
            {file.filename}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>{formatBytes(file.size)}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <ArtifactPreviewActions
            item={item}
            googleDriveConnected={googleDriveConnected}
            agentId={agentId}
            threadId={threadId}
            onSyncSuccess={onSyncSuccess}
          />
        </div>
      </div>
    </div>
  );
}

function ArtifactThumbnail({
  file,
  selected,
}: {
  file: ChatThreadArtifactFile;
  selected: boolean;
}) {
  const previewKind = getArtifactPreviewKind(file);

  return (
    <div
      className={cn(
        "relative flex h-14 w-20 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted/60 transition-colors",
        selected
          ? "border-primary/60 ring-2 ring-primary/15"
          : "border-border/70 hover:border-foreground/25",
      )}
      aria-hidden="true"
    >
      {previewKind === "image" ? (
        <ArtifactThumbnailImage url={file.url} />
      ) : (
        <ArtifactFileIcon file={file} />
      )}
    </div>
  );
}

function ArtifactThumbnailImage({ url }: { url: string }) {
  const imageLoadStatuses = useGet(imageLoadStatusByKey$);
  const imageLoadStatusRef = useSet(imageLoadStatusRef$);
  const setImageLoadStatus = useSet(setImageLoadStatus$);
  const imageLoadKey = `artifact-thumbnail:${url}`;
  const imageStatus = imageLoadStatuses[imageLoadKey] ?? "loading";

  const showPlaceholder = imageStatus !== "loaded";

  return (
    <>
      {showPlaceholder && (
        <span className="flex h-full w-full items-center justify-center bg-muted/70 text-muted-foreground">
          {imageStatus === "loading" ? (
            <IconLoader2 size={14} stroke={1.8} className="animate-spin" />
          ) : (
            <IconPhoto size={14} stroke={1.5} />
          )}
        </span>
      )}
      <img
        key={imageLoadKey}
        ref={imageLoadStatusRef}
        src={url}
        alt=""
        data-image-load-key={imageLoadKey}
        loading="lazy"
        onLoad={() => {
          setImageLoadStatus(imageLoadKey, "loaded");
        }}
        onError={() => {
          setImageLoadStatus(imageLoadKey, "error");
        }}
        className={cn(
          "h-full w-full object-cover",
          showPlaceholder && "absolute inset-0 opacity-0",
        )}
        aria-hidden="true"
      />
    </>
  );
}

function ArtifactFileRow({
  item,
  selected,
  onPreview,
}: {
  item: ChatArtifactItem;
  selected: boolean;
  onPreview: () => void;
}) {
  const { file } = item;

  return (
    <div
      className={cn(
        "flex rounded-lg border transition-colors",
        selected
          ? "border-primary/40 bg-primary/5"
          : "border-border/60 bg-background/70 hover:bg-muted/25",
      )}
    >
      <button
        type="button"
        onClick={onPreview}
        className="flex min-w-0 flex-1 items-start gap-3 rounded-lg px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-label={`Select ${file.filename}`}
      >
        <ArtifactThumbnail file={file} selected={selected} />
        <div className="min-w-0 flex-1">
          <span
            className="block max-w-full truncate text-sm font-medium text-foreground"
            title={file.filename}
          >
            {file.filename}
          </span>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>{formatBytes(file.size)}</span>
            <span aria-hidden>·</span>
            <span>{formatArtifactTime(file.createdAt)}</span>
          </div>
        </div>
      </button>
    </div>
  );
}

function ChatArtifactsDrawerContent({ thread }: { thread: ChatThreadSignals }) {
  const loadable = useLastLoadable(thread.artifacts$);
  const connectorList = useLastResolved(connectors$);
  const agentId = useLastResolved(thread.agentId$);
  const selectedArtifactKey = useGet(thread.artifactPreviewKey$);
  const setSelectedArtifactKey = useSet(thread.setArtifactPreviewKey$);
  const reloadArtifacts = useSet(thread.setArtifactsDrawerOpen$);

  if (loadable.state === "loading") {
    return (
      <div className="flex flex-col gap-3">
        {Array.from({ length: 4 }, (_, i) => {
          return <Skeleton key={i} className="h-16 rounded-lg" />;
        })}
      </div>
    );
  }

  if (loadable.state === "hasError") {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        Failed to load artifacts
      </div>
    );
  }

  if (loadable.state !== "hasData") {
    return null;
  }

  const runs = loadable.data;
  const items = flattenArtifactRuns(runs);
  const selectedItem =
    items.find((item) => {
      return artifactItemKey(item) === selectedArtifactKey;
    }) ?? items[0];
  const totalFiles = runs.reduce((sum, run) => {
    return sum + run.files.length;
  }, 0);

  if (totalFiles === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border/70 p-8 text-center">
        <img
          src={emptyArtifactImg}
          alt=""
          role="presentation"
          loading="lazy"
          className="h-24 w-24 object-contain opacity-80"
        />
        <p className="text-sm text-muted-foreground">
          No uploaded files in this chat yet.
        </p>
      </div>
    );
  }

  const selectedKey = selectedItem ? artifactItemKey(selectedItem) : null;
  const googleDriveConnected =
    connectorList?.connectors.some((connector) => {
      return connector.type === "google-drive" && !connector.needsReconnect;
    }) ?? false;
  const refreshArtifactSyncStatus = () => {
    reloadArtifacts(true);
  };

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {selectedItem && (
        <ArtifactPreviewPanel
          item={selectedItem}
          googleDriveConnected={googleDriveConnected}
          agentId={agentId}
          onSyncSuccess={refreshArtifactSyncStatus}
          threadId={thread.threadId}
        />
      )}
      <div className="flex items-center justify-between border-b border-border/60 pb-3 text-xs text-muted-foreground">
        <span>
          {totalFiles} file{totalFiles === 1 ? "" : "s"}
        </span>
        <ArtifactBulkActionsMenu
          items={items}
          googleDriveConnected={googleDriveConnected}
          agentId={agentId}
          onSyncSuccess={refreshArtifactSyncStatus}
          threadId={thread.threadId}
        />
      </div>
      <div className="flex flex-col gap-2">
        {items.map((item) => {
          const itemKey = artifactItemKey(item);
          return (
            <ArtifactFileRow
              key={itemKey}
              item={item}
              selected={selectedKey === itemKey}
              onPreview={() => {
                setSelectedArtifactKey(itemKey);
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

function ChatArtifactsDrawer({ thread }: { thread: ChatThreadSignals }) {
  const open = useGet(thread.artifactsDrawerOpen$);
  const setOpen = useSet(thread.setArtifactsDrawerOpen$);
  const setArtifactsRealtimeRef = useSet(thread.setArtifactsRealtimeRef$);
  const lightboxUrl = useGet(attachmentLightboxUrl$);

  return (
    <Sheet
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
      }}
    >
      <SheetContent
        side="right"
        className="flex w-[420px] max-w-[100vw] flex-col"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
        }}
        onEscapeKeyDown={(event) => {
          if (lightboxUrl) {
            event.preventDefault();
          }
        }}
        onInteractOutside={(event) => {
          if (lightboxUrl) {
            event.preventDefault();
          }
        }}
      >
        <SheetHeader className="shrink-0">
          <SheetTitle>Artifacts</SheetTitle>
          <SheetDescription>
            Uploaded files from runs in this chat thread.
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 min-h-0 overflow-y-auto -mx-6 px-6 -mb-6 pb-6">
          {open && (
            <div ref={setArtifactsRealtimeRef}>
              <ChatArtifactsDrawerContent thread={thread} />
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// ZeroSessionChatPage — real conversation backed by agent runs
// ---------------------------------------------------------------------------

function ChatThread({
  thread,
  onKeyDown,
}: {
  thread: ChatThreadSignals;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
}) {
  return (
    <section
      aria-label="Chat thread"
      className="flex min-w-0 basis-0 flex-1 flex-col min-h-0 bg-transparent focus:outline-none"
      data-chat-thread-container-id={thread.threadId}
      onKeyDown={onKeyDown}
      tabIndex={-1}
    >
      <ChatThreadContent thread={thread} />
    </section>
  );
}

export function ZeroChatThreadPage() {
  const shortcutHelpOpen = useGet(chatShortcutHelpOpen$);
  const setShortcutHelpOpen = useSet(setChatShortcutHelpOpen$);
  const leftThread = useGet(currentLeftThread$);
  const rightThread = useGet(currentRightThread$);
  const lightboxUrl = useGet(attachmentLightboxUrl$);
  const setKeyboardScrollRoot = useSet(setChatKeyboardScrollRoot$);
  const sidebarEnabled = useGet(chatArtifactSidebarEnabled$);
  const artifactRef = useGet(currentArtifactRef$);
  const artifactSidebarOpen = sidebarEnabled && artifactRef !== null;
  // Lifted from ChatThread so the keyboard handler's sidebarChatThreads$
  // snapshot survives keyed ChatThread remounts during thread navigation.
  // Otherwise a second mod+shift+arrow press lands on a freshly mounted
  // ChatThread whose useLastResolved has no cached value yet, leading to an
  // empty threads list and a silently dropped keypress.
  const makeChatThreadKeyDown = useChatThreadKeyDownFactory();

  const threadArea = (
    <div
      ref={setKeyboardScrollRoot}
      className="flex flex-1 min-h-0 bg-transparent"
    >
      {leftThread && (
        <ChatThread
          key={leftThread.threadId}
          thread={leftThread}
          onKeyDown={makeChatThreadKeyDown(leftThread)}
        />
      )}
      {rightThread && (
        <>
          <div className="w-px shrink-0 bg-border/60" aria-hidden="true" />
          <ChatThread
            key={rightThread.threadId}
            thread={rightThread}
            onKeyDown={makeChatThreadKeyDown(rightThread)}
          />
        </>
      )}
    </div>
  );

  return (
    <>
      {/* Keep the wrapper structure stable across artifact open/close so the
          thread area's React subtree (and its scroll/keyboard state) never
          unmounts when the sidebar appears. Only the wrapper className and
          the optional sidebar sibling change with state. Below xl: the
          thread half hides so the sidebar fills the pane (no toggle, the
          50/50 split needs each half ~640px to clear the composer's sm:
          breakpoint, below which the model picker collapses to icons). */}
      <div className="flex flex-1 min-h-0 bg-transparent">
        <div
          className={
            artifactSidebarOpen
              ? "hidden xl:flex flex-1 basis-0 min-w-0 min-h-0"
              : "flex flex-1 min-w-0 min-h-0"
          }
        >
          {threadArea}
        </div>
        {artifactSidebarOpen && (
          <div className="flex flex-1 basis-0 min-w-0 min-h-0">
            <ArtifactSidebarSlot />
          </div>
        )}
      </div>
      {!sidebarEnabled && leftThread && (
        <ChatArtifactsDrawer thread={leftThread} />
      )}
      {!sidebarEnabled && rightThread && (
        <ChatArtifactsDrawer key={rightThread.threadId} thread={rightThread} />
      )}
      {lightboxUrl && <AttachmentLightbox />}
      <ShortcutHelpDialog
        open={shortcutHelpOpen}
        onOpenChange={setShortcutHelpOpen}
        description="Available shortcuts on this page"
        sections={CHAT_SHORTCUT_SECTIONS}
      />
      <ChatConnectorActionConnectModal />
    </>
  );
}

type LoadableValue<T> =
  | { state: "loading" }
  | { state: "hasData"; data: T }
  | { state: "hasError"; error: unknown };

function resolveSessionError(
  threadDataLoadable: LoadableValue<ChatThread | null>,
  groupsLoadable: LoadableValue<GroupedChatMessageGroup[]>,
): string | null {
  if (threadDataLoadable.state === "hasError") {
    return threadDataLoadable.error instanceof Error
      ? threadDataLoadable.error.message
      : "Failed to load chat";
  }
  if (groupsLoadable.state === "hasError") {
    return groupsLoadable.error instanceof Error
      ? groupsLoadable.error.message
      : "Failed to load messages";
  }
  if (
    threadDataLoadable.state === "hasData" &&
    threadDataLoadable.data === null
  ) {
    return "Chat not found";
  }
  return null;
}

type GithubPrTrackingLayoutStyle = CSSProperties &
  Record<
    "--github-pr-tracking-dock-width" | "--github-pr-tracking-content-inset",
    string
  >;

const CHAT_THREAD_CONTENT_MAIN_CLASS =
  "items-center py-4 pl-4 pr-[calc(var(--github-pr-tracking-content-inset)_+_1rem)] sm:pl-6 sm:pr-[calc(var(--github-pr-tracking-content-inset)_+_1.5rem)] @container";
const GITHUB_PR_TRACKING_DOCK_WIDTH =
  "min(400px, max(280px, calc(100% - 760px)))";

function githubPrTrackingLayoutStyle(
  githubPrTrackingOpen: boolean,
): GithubPrTrackingLayoutStyle {
  return {
    "--github-pr-tracking-dock-width": GITHUB_PR_TRACKING_DOCK_WIDTH,
    "--github-pr-tracking-content-inset": githubPrTrackingOpen
      ? "calc(var(--github-pr-tracking-dock-width) + 0.75rem)"
      : "0px",
  };
}

function useGithubPrTrackingOpen(
  thread: ChatThreadSignals,
  threadDataLoadable: LoadableValue<ChatThread | null>,
): boolean {
  const openGithubPrTrackingThreadId = useGet(githubPrTrackingOpenThreadId$);
  const features = useLastResolved(featureSwitch$);
  const githubPrTrackingEnabled =
    features?.[FeatureSwitchKey.ChatGithubPrTracking] ?? false;
  const agentId =
    threadDataLoadable.state === "hasData"
      ? (threadDataLoadable.data?.agentId ?? null)
      : null;

  return (
    githubPrTrackingEnabled &&
    openGithubPrTrackingThreadId === thread.threadId &&
    agentId !== null
  );
}

function ChatThreadMessagesMain({
  thread,
  groups,
  activeGroups,
  sessionError,
  skeletonVisible,
  hasOlderHistory,
  loadingHistory,
  messagesLoading,
  onLoadHistory,
}: {
  thread: ChatThreadSignals;
  groups: GroupedChatMessageGroup[];
  activeGroups: GroupedChatMessageGroup[];
  sessionError: string | null;
  skeletonVisible: boolean;
  hasOlderHistory: boolean;
  loadingHistory: boolean;
  messagesLoading: boolean;
  onLoadHistory: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  const showEmptyState =
    !sessionError &&
    groups.length === 0 &&
    !messagesLoading &&
    !skeletonVisible;

  return (
    <main className={CHAT_THREAD_CONTENT_MAIN_CLASS}>
      <div
        data-message-container
        className="w-full max-w-[900px] mx-auto flex flex-col gap-6 pb-4 overflow-visible"
        style={{ visibility: skeletonVisible ? "hidden" : "visible" }}
      >
        {!sessionError && !skeletonVisible && hasOlderHistory && (
          <div className="flex justify-center">
            <button
              type="button"
              disabled={loadingHistory}
              onClick={onLoadHistory}
              className="inline-flex h-8 items-center rounded-lg border border-border bg-background px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              Load history
            </button>
          </div>
        )}
        {sessionError && (
          <div className="flex-1 flex items-center justify-center py-16">
            <div className="flex items-center gap-2 text-destructive">
              <IconAlertCircle size={16} />
              <p className="text-sm">{sessionError}</p>
            </div>
          </div>
        )}
        {showEmptyState && (
          <div className="flex-1 flex flex-col items-center justify-center py-16 gap-3">
            <img
              src={emptyChatImg}
              alt=""
              role="presentation"
              loading="lazy"
              className="h-24 w-24 object-contain opacity-80"
            />
            <p className="text-sm text-muted-foreground">
              Send a message to start the conversation
            </p>
          </div>
        )}
        {activeGroups.map((group) => {
          return (
            <PagedGroupRow
              key={group.beginMessageId}
              group={group}
              thread={thread}
            />
          );
        })}
        <ThinkingIndicator thread={thread} groups={activeGroups} />
      </div>
    </main>
  );
}

function ChatThreadSkeletonOverlay({
  sessionError,
  skeletonVisible,
}: {
  sessionError: string | null;
  skeletonVisible: boolean;
}) {
  if (!skeletonVisible || sessionError) {
    return null;
  }

  return (
    <div
      data-chat-skeleton
      className="absolute inset-0 z-10 overflow-hidden pointer-events-none bg-background"
    >
      <main className={CHAT_THREAD_CONTENT_MAIN_CLASS}>
        <div className="w-full max-w-[900px] mx-auto flex flex-col gap-6 pb-4">
          <ChatSkeleton />
        </div>
      </main>
    </div>
  );
}

// Lifted to ZeroChatThreadPage so the useLastResolved(sidebarChatThreads$)
// snapshot survives keyed ChatThread remounts during thread navigation.
function useChatThreadKeyDownFactory() {
  const pageSignal = useGet(pageSignal$);
  const scrollCurrentThread = useSet(scrollCurrentThread$);
  const navigateToAdjacentThread = useSet(navigateToAdjacentThread$);
  const setShortcutHelpOpen = useSet(setChatShortcutHelpOpen$);
  // Snapshot the sidebar list on the read side so the keyboard command stays
  // sync — awaiting `sidebarChatThreads$` inside the command would block the
  // keypress on whatever async work that signal is currently doing
  // (e.g. an IDB miss + remote refetch).
  const sidebarThreads = useLastResolved(sidebarChatThreads$) ?? [];

  return (thread: ChatThreadSignals) => {
    return onDomEventFn(async (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.defaultPrevented) {
        return;
      }
      if (matchShortcut("mod+arrowup", event)) {
        event.preventDefault();
        scrollCurrentThread(thread, "top");
        return;
      }
      if (matchShortcut("mod+arrowdown", event)) {
        event.preventDefault();
        scrollCurrentThread(thread, "bottom");
        return;
      }
      if (matchShortcut("mod+shift+arrowup", event)) {
        event.preventDefault();
        await navigateToAdjacentThread(
          {
            currentThreadId: thread.threadId,
            direction: "prev",
            threads: sidebarThreads,
          },
          pageSignal,
        );
        return;
      }
      if (matchShortcut("mod+shift+arrowdown", event)) {
        event.preventDefault();
        await navigateToAdjacentThread(
          {
            currentThreadId: thread.threadId,
            direction: "next",
            threads: sidebarThreads,
          },
          pageSignal,
        );
        return;
      }

      if (matchShortcut("shift+/", event) && !isEditableTarget(event.target)) {
        event.preventDefault();
        setShortcutHelpOpen(true);
      }
    });
  };
}

function ChatThreadContent({ thread }: { thread: ChatThreadSignals }) {
  const groupsLoadable = useLastLoadable(thread.groupedChatMessages$);
  const hasOlderHistory = useLastResolved(thread.hasOlderHistory$) ?? false;
  const [loadHistoryLoadable, loadHistory] = useLoadableSet(
    thread.loadHistory$,
  );
  const threadDataLoadable = useLastLoadable(thread.threadData$);
  const sessionError = resolveSessionError(threadDataLoadable, groupsLoadable);
  const messagesLoading = groupsLoadable.state === "loading";
  const groups = groupsLoadable.state === "hasData" ? groupsLoadable.data : [];
  const { activeGroups } = splitQueuedMessagesForThinkingIndicator(groups);
  const setScrollContainer = useSet(thread.setScrollContainer$);
  const skeletonVisible = useGet(thread.skeletonVisible$);
  const loadingHistory = loadHistoryLoadable.state === "loading";
  const pageSignal = useGet(pageSignal$);
  const onLoadHistory = onDomEventFn(() => {
    return loadHistory(pageSignal);
  });
  const githubPrTrackingOpen = useGithubPrTrackingOpen(
    thread,
    threadDataLoadable,
  );

  return (
    <>
      <ChatThreadHeader thread={thread} />

      <div
        className="relative min-h-0 flex-1"
        style={githubPrTrackingLayoutStyle(githubPrTrackingOpen)}
      >
        <div className="flex h-full min-w-0 flex-col">
          <div className="flex-1 min-h-0 relative isolate">
            <div
              ref={setScrollContainer}
              data-scroll-container
              tabIndex={-1}
              className="absolute inset-0 overflow-y-auto focus:outline-none [scrollbar-gutter:stable]"
            >
              <ChatThreadMessagesMain
                thread={thread}
                groups={groups}
                activeGroups={activeGroups}
                sessionError={sessionError}
                skeletonVisible={skeletonVisible}
                hasOlderHistory={hasOlderHistory}
                loadingHistory={loadingHistory}
                messagesLoading={messagesLoading}
                onLoadHistory={onLoadHistory}
              />
            </div>
            <ChatThreadSkeletonOverlay
              sessionError={sessionError}
              skeletonVisible={skeletonVisible}
            />
            <ChatScrollToBottomButton
              thread={thread}
              skeletonVisible={skeletonVisible}
              sessionError={sessionError}
            />
          </div>

          <ChatThreadComposer thread={thread} />
        </div>

        {githubPrTrackingOpen && <GithubPrTrackingDock thread={thread} />}
      </div>
    </>
  );
}

function ChatScrollToBottomButton({
  thread,
  skeletonVisible,
  sessionError,
}: {
  thread: ChatThreadSignals;
  skeletonVisible: boolean;
  sessionError: string | null;
}) {
  const features = useLastResolved(featureSwitch$);
  const enabled =
    features?.[FeatureSwitchKey.ChatScrollToBottomButton] ?? false;
  const awayFromBottom = useGet(thread.awayFromBottom$);
  const scrollToBottom = useSet(thread.scrollToBottom$);

  if (!enabled || !awayFromBottom || skeletonVisible || sessionError) {
    return null;
  }

  return (
    <button
      type="button"
      data-scroll-to-bottom
      aria-label="Scroll to bottom"
      onClick={() => {
        scrollToBottom();
      }}
      className="absolute bottom-4 right-[calc(var(--github-pr-tracking-content-inset,0px)_+_1rem)] z-20 flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-md transition-colors hover:bg-accent hover:text-foreground"
    >
      <IconArrowDown size={18} />
    </button>
  );
}

interface RecommendedFollowupSource {
  readonly messageId: string;
  readonly followups: readonly RecommendedFollowup[];
}

function latestRecommendedFollowups(
  groups: readonly GroupedChatMessageGroup[],
): RecommendedFollowupSource | null {
  const lastGroup = groups[groups.length - 1];
  if (lastGroup?.role !== "assistant") {
    return null;
  }
  const lastMessage = lastGroup.messages[lastGroup.messages.length - 1];
  if (!lastMessage || lastMessage.role !== "assistant") {
    return null;
  }
  if (lastMessage.runLifecycleEvent !== undefined) {
    return null;
  }
  const followups = lastMessage.recommendedFollowups ?? [];
  if (followups.length === 0) {
    return null;
  }
  return { messageId: lastMessage.id, followups };
}

function RecommendedFollowupIcon({
  followup,
}: {
  followup: RecommendedFollowup;
}) {
  if (followup.kind !== "generate") {
    return <IconMessageCircle size={14} stroke={1.8} />;
  }

  if (followup.generationType === "image") {
    return <IconPhoto size={14} stroke={1.8} />;
  }
  if (followup.generationType === "video") {
    return <IconVideo size={14} stroke={1.8} />;
  }
  if (followup.generationType === "presentation") {
    return <IconChartLine size={14} stroke={1.8} />;
  }
  if (followup.generationType === "website") {
    return <IconLink size={14} stroke={1.8} />;
  }
  return <IconPackage size={14} stroke={1.8} />;
}

function recommendedFollowupShownKey(
  source: RecommendedFollowupSource,
): string {
  return [
    source.messageId,
    source.followups.length,
    ...source.followups.map((followup) => {
      return `${followup.kind}:${followup.generationType ?? ""}`;
    }),
  ].join("|");
}

function reportRecommendedFollowupsShown(
  element: HTMLDivElement | null,
  source: RecommendedFollowupSource,
): void {
  if (!element) {
    return;
  }

  const shownKey = recommendedFollowupShownKey(source);
  if (element.dataset.recommendedFollowupsShownKey === shownKey) {
    return;
  }
  element.dataset.recommendedFollowupsShownKey = shownKey;

  captureRecommendedFollowupsShown({
    messageId: source.messageId,
    followups: source.followups,
  });
}

function RecommendedFollowupList({
  thread,
  source,
}: {
  thread: ChatThreadSignals;
  source: RecommendedFollowupSource;
}) {
  const [, sendMessage] = useLoadableSet(thread.sendMessage$);
  const modelSelection = useLastResolved(thread.modelSelection$) ?? null;
  const rootSignal = useGet(rootSignal$);
  const handleRecommendedFollowupsRef = (element: HTMLDivElement | null) => {
    reportRecommendedFollowupsShown(element, source);
  };

  const handleSelect = (
    followup: RecommendedFollowup,
    followupIndex: number,
  ) => {
    captureRecommendedFollowupSelected({
      messageId: source.messageId,
      followupIndex,
      followupCount: source.followups.length,
      followup,
    });
    detach(
      sendMessage(
        followup.prompt,
        modelSelection,
        {
          revokesMessageId: source.messageId,
          includeDraftAttachments: false,
        },
        rootSignal,
      ),
      Reason.DomCallback,
    );
  };

  return (
    <div
      ref={handleRecommendedFollowupsRef}
      className="-mx-2 divide-y divide-border/60"
    >
      {source.followups.map((followup, followupIndex) => {
        return (
          <button
            key={followup.prompt}
            type="button"
            className="group flex min-h-10 w-full items-center gap-2 px-2 py-2 text-left transition-colors first:rounded-t-lg last:rounded-b-lg hover:bg-muted/40"
            onClick={() => {
              handleSelect(followup, followupIndex);
            }}
          >
            <span className="shrink-0 text-muted-foreground/70 transition-colors group-hover:text-foreground">
              <RecommendedFollowupIcon followup={followup} />
            </span>
            <span className="min-w-0 flex-1 break-words text-xs font-medium leading-5 text-muted-foreground group-hover:text-foreground">
              {followup.prompt}
            </span>
            <IconArrowRight
              size={14}
              stroke={1.8}
              className="shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground"
            />
          </button>
        );
      })}
    </div>
  );
}

function splitQueuedMessagesForThinkingIndicator(
  groups: GroupedChatMessageGroup[],
): {
  activeGroups: GroupedChatMessageGroup[];
  queuedGroups: GroupedChatMessageGroup[];
} {
  const activeGroups: GroupedChatMessageGroup[] = [];
  const queuedMessages: EnrichedChatMessage[] = [];

  for (const group of groups) {
    if (group.role !== "user") {
      activeGroups.push(group);
      continue;
    }

    const activeMessages: EnrichedChatMessage[] = [];
    for (const message of group.messages) {
      if (message.isQueued) {
        queuedMessages.push(message);
      } else {
        activeMessages.push(message);
      }
    }

    if (activeMessages.length > 0) {
      activeGroups.push({
        ...group,
        beginMessageId: activeMessages[0]!.id,
        messages: activeMessages,
      });
    }
  }

  return {
    activeGroups,
    queuedGroups:
      queuedMessages.length > 0
        ? [
            {
              beginMessageId: queuedMessages[0]!.id,
              role: "user",
              messages: queuedMessages,
            },
          ]
        : [],
  };
}

// ---------------------------------------------------------------------------
// Composer wrapper — reads chat signals from thread prop
// ---------------------------------------------------------------------------

function canQueueMessage({ sending }: { sending: boolean }): boolean {
  return sending;
}

function shouldAutoFocusComposer({
  autoFocus,
  hasMessages,
}: {
  autoFocus: boolean;
  hasMessages: boolean;
}): boolean {
  return (
    autoFocus && !hasMessages && !window.matchMedia("(pointer: coarse)").matches
  );
}

interface ChatComposerModelPickerConfig {
  value: ModelProviderSelection | null;
  onChange: (value: ModelProviderSelection | null) => void;
  disabled: boolean;
  defaultSelection: ModelProviderSelection | null;
}

function resolveChatComposerModelPicker(params: {
  modelSelection: ModelProviderSelection | null;
  setModelSelection: (value: ModelProviderSelection | null) => void;
  disabled: boolean;
  defaultSelection: ModelProviderSelection | null;
}): ChatComposerModelPickerConfig {
  return {
    value: params.modelSelection,
    onChange: params.setModelSelection,
    disabled: params.disabled,
    defaultSelection: params.defaultSelection,
  };
}

function useChatComposerQueue(
  thread: ChatThreadSignals,
  groups: GroupedChatMessageGroup[],
) {
  const recallMessage = useSet(thread.recallMessage$);
  const focusInput = useSet(thread.focusInput$);
  const pageSignal = useGet(pageSignal$);

  const { queuedGroups } = splitQueuedMessagesForThinkingIndicator(groups);
  const queuedMessagesById = new Map(
    queuedGroups.flatMap((group) => {
      return group.messages.map((message) => {
        return [message.id, message] as const;
      });
    }),
  );
  const queuedItems: QueuedComposerItem[] = Array.from(
    queuedMessagesById.values(),
  ).map((message) => {
    return {
      id: message.id,
      text: (message.content ?? "").trim(),
    };
  });

  const onRemoveQueuedItem = (id: string) => {
    const message = queuedMessagesById.get(id);
    if (!message) {
      return;
    }
    detach(
      (async () => {
        await recallMessage(message, pageSignal);
        focusInput();
      })(),
      Reason.DomCallback,
    );
  };

  return { queuedItems, onRemoveQueuedItem };
}

function useChatComposerModel(
  thread: ChatThreadSignals,
  pageSignal: AbortSignal,
) {
  // Per-thread composer state lives in ccstate signals on the factory so the
  // initial value seeds from threadData once it resolves (a React useState
  // initializer would snapshot `undefined` on first render). `modelSelection$`
  // internally flips to a user-override once `setModelSelection$` is called,
  // so unsaved edits survive subsequent threadData$ reloads. Read with
  // useLastResolved so the picker keeps the previous value during the
  // threadData$ refetches triggered by chatThreadRunUpdated Ably events —
  // otherwise the picker briefly flips to a skeleton on every run change.
  const threadDataResolved = useLastResolved(thread.threadData$);
  const modelSelectionResolved = useLastResolved(thread.modelSelection$);
  const defaultModelSelectionResolved = useLastResolved(
    thread.defaultModelSelection$,
  );
  const modelSelection = modelSelectionResolved ?? null;
  const defaultModelSelection = defaultModelSelectionResolved ?? null;
  const setModelSelection = useSet(thread.setModelSelection$);
  const updateUserModelPreference = useSet(updateUserModelPreference$);
  const modelFirstOauthState = useLastResolved(modelFirstPersonalOauthState$);
  const openPersonalOauthConfiguration = usePersonalOauthConfigurationAction();

  const handleModelSelectionChange = (
    selection: ModelProviderSelection | null,
  ): void => {
    setModelSelection(selection);
    const selectedModel = selection?.selectedModel;
    if (isSupportedRunModel(selectedModel)) {
      detach(
        updateUserModelPreference({ selectedModel }, pageSignal),
        Reason.DomCallback,
      );
    }
  };

  const modelPicker = resolveChatComposerModelPicker({
    modelSelection,
    setModelSelection: handleModelSelectionChange,
    disabled: false,
    defaultSelection: defaultModelSelection,
  });
  // Skeleton only on cold start (nothing has ever resolved). Once we have any
  // resolved value, refetches reuse the cached value instead of flashing.
  const modelPickerLoading =
    threadDataResolved === undefined ||
    modelSelectionResolved === undefined ||
    defaultModelSelectionResolved === undefined;
  const submitBlockerProps = resolveChatComposerSubmitBlocker({
    state: modelFirstOauthState,
    modelSelection,
    onAction: openPersonalOauthConfiguration,
  });

  return {
    modelPicker,
    modelPickerLoading,
    submitBlockerProps,
    modelSelection,
  };
}

function ChatThreadComposer({
  thread,
  autoFocus: autoFocusProp = true,
}: {
  thread: ChatThreadSignals;
  autoFocus?: boolean;
}) {
  const groupsLoadable = useLastLoadable(thread.groupedChatMessages$);
  const groups = groupsLoadable.state === "hasData" ? groupsLoadable.data : [];
  const hasMessages = groups.length > 0;
  const messagesResolved = groupsLoadable.state === "hasData";
  const displayName = useLastResolved(thread.agentDisplayName$) ?? "Zero";
  // useLastResolved (not useLastLoadable) so refetches keep the previously
  // resolved value instead of flipping `sending` and the placeholder. Before
  // the first resolution, avoid showing a Stop button for a thread that may
  // already be idle.
  const allFinishedResolvedValue = useLastResolved(thread.allFinished$);
  const allFinishedResolved = allFinishedResolvedValue !== undefined;
  const allFinished = allFinishedResolvedValue ?? false;
  const [sendLoadable, send] = useLoadableSet(thread.sendMessage$);
  const [, queueMessage] = useLoadableSet(thread.queueMessage$);
  const sending =
    (allFinishedResolved && !allFinished) || sendLoadable.state === "loading";
  const input = useGet(thread.draft.input$);
  const setInput = useSet(thread.draft.setInput$);
  const cancelRun = useSet(thread.cancelRun$);
  const setInputRef = useSet(thread.setInputRef$);
  const scheduleDraftSync = useSet(thread.scheduleDraftSync$);
  const pageSignal = useGet(pageSignal$);
  const rootSignal = useGet(rootSignal$);

  const { queuedItems, onRemoveQueuedItem } = useChatComposerQueue(
    thread,
    groups,
  );
  const {
    modelPicker,
    modelPickerLoading,
    submitBlockerProps,
    modelSelection,
  } = useChatComposerModel(thread, pageSignal);
  const skeletonVisible = useGet(thread.skeletonVisible$);
  const lastGroup = groups[groups.length - 1];
  const lastIsAssistant = lastGroup?.role === "assistant";
  const lastAssistantMessage =
    lastIsAssistant && lastGroup
      ? lastGroup.messages[lastGroup.messages.length - 1]
      : undefined;
  const lastAssistantCancelled =
    isCancelledAssistantMessage(lastAssistantMessage);
  const composerSending = sending && !lastAssistantCancelled;
  const queueWhileSending = canQueueMessage({
    sending: composerSending,
  });

  const handleInputChange = (text: string) => {
    setInput(text);
    detach(scheduleDraftSync(pageSignal), Reason.DomCallback);
  };

  const handleDraftChange = () => {
    detach(scheduleDraftSync(pageSignal), Reason.DomCallback);
  };

  const handleSend = (text: string) => {
    setInput("");
    // Use rootSignal so in-run page navigation (e.g. IPA internal nav) doesn't
    // cancel the pending send.
    detach(
      send(text, modelSelection, undefined, rootSignal),
      Reason.DomCallback,
    );
  };

  const handleQueue = (text: string) => {
    setInput("");
    detach(queueMessage(text, rootSignal), Reason.DomCallback);
  };

  return (
    <footer
      data-chat-composer
      className="relative shrink-0 bg-[hsl(var(--background))]"
      style={{ paddingBottom: "max(0.5rem, var(--sab))" }}
    >
      <div className="pointer-events-none absolute inset-x-0 -top-5 h-[21px] bg-gradient-to-t from-[hsl(var(--background))] to-transparent" />
      <div className="overflow-y-auto [scrollbar-gutter:stable] pb-2 pl-4 pr-[calc(var(--github-pr-tracking-content-inset,0px)_+_1rem)] pt-3 sm:pl-6 sm:pr-[calc(var(--github-pr-tracking-content-inset,0px)_+_1.5rem)]">
        <div className="mx-auto max-w-[900px]">
          <ZeroChatComposer
            className="w-full min-w-0"
            input={input}
            onInputChange={handleInputChange}
            onSend={handleSend}
            onQueue={handleQueue}
            sending={composerSending}
            queueWhileSending={queueWhileSending}
            onCancel={
              allFinishedResolved
                ? () => {
                    detach(cancelRun(pageSignal), Reason.DomCallback);
                  }
                : undefined
            }
            displayName={displayName}
            autoFocus={shouldAutoFocusComposer({
              autoFocus: autoFocusProp,
              hasMessages,
            })}
            onDraftChange={handleDraftChange}
            draft={thread.draft}
            composerFileInput$={thread.composerFileInput$}
            setComposerFileInput$={thread.setComposerFileInput$}
            setInputRef={setInputRef}
            actionsLoading={skeletonVisible}
            modelPicker={modelPicker}
            modelPickerLoading={modelPickerLoading || !messagesResolved}
            submitBlocker={submitBlockerProps}
            queuedItems={queuedItems}
            onRemoveQueuedItem={onRemoveQueuedItem}
          />
          <PersonalProviderDialog />
          <PersonalClaudeCodeDeviceAuthDialog />
          <PersonalCodexDeviceAuthDialog />
        </div>
      </div>
    </footer>
  );
}

// ---------------------------------------------------------------------------
// Skeleton placeholder while session loads
// ---------------------------------------------------------------------------

function ChatSkeleton() {
  return (
    <>
      {/* User bubble skeleton */}
      <div className="flex justify-end">
        <Skeleton className="h-10 w-[60%] rounded-xl" />
      </div>
      {/* Assistant bubble skeleton */}
      <div className="flex flex-col gap-2 @[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
        <Skeleton className="h-7 w-7 @[900px]:h-9 @[900px]:w-9 shrink-0 @[900px]:mt-0.5 rounded-xl" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-[90%] rounded-lg" />
          <Skeleton className="h-4 w-[75%] rounded-lg" />
          <Skeleton className="h-4 w-[40%] rounded-lg" />
        </div>
      </div>
      {/* User bubble skeleton */}
      <div className="flex justify-end">
        <Skeleton className="h-10 w-[45%] rounded-xl" />
      </div>
      {/* Assistant bubble skeleton */}
      <div className="flex flex-col gap-2 @[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
        <Skeleton className="h-7 w-7 @[900px]:h-9 @[900px]:w-9 shrink-0 @[900px]:mt-0.5 rounded-xl" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-[85%] rounded-lg" />
          <Skeleton className="h-4 w-[60%] rounded-lg" />
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Thinking indicator — shown the entire time a run is active
// ---------------------------------------------------------------------------

function isCancelledAssistantMessage(
  message: EnrichedChatMessage | undefined,
): boolean {
  return (
    message?.role === "assistant" &&
    (message.runLifecycleEvent === "cancelled" ||
      message.error?.trim().toLowerCase() === "run cancelled")
  );
}

function shouldRenderThinkingIndicator({
  lastGroup,
  lastIsAssistant,
  running,
  lastAssistantCancelled,
}: {
  lastGroup: GroupedChatMessageGroup | undefined;
  lastIsAssistant: boolean;
  running: boolean;
  lastAssistantCancelled: boolean;
}): boolean {
  if (!lastGroup) {
    return false;
  }
  if (lastAssistantCancelled && !running) {
    return false;
  }
  return lastIsAssistant || running;
}

function ThinkingLabel({
  isQueued,
  rotatingLabel,
}: {
  isQueued: boolean;
  rotatingLabel: string;
}) {
  const openQueueDrawer = useSet(openQueueDrawer$);
  const pageSignal = useGet(pageSignal$);

  if (isQueued) {
    return (
      <p className="zero-shimmer-text text-xs truncate">
        Waiting in{" "}
        <button
          type="button"
          onClick={() => {
            openQueueDrawer(pageSignal);
          }}
          className="cursor-pointer underline underline-offset-2"
        >
          queue...
        </button>
      </p>
    );
  }

  return <p className="zero-shimmer-text text-xs truncate">{rotatingLabel}</p>;
}

function InlineThinkingRow({
  blockStyle,
  isQueued,
  rotatingLabel,
}: {
  blockStyle: CSSProperties;
  isQueued: boolean;
  rotatingLabel: string;
}) {
  return (
    <div className="flex items-center gap-2 h-5">
      <span className="zero-blocks shrink-0" style={blockStyle}>
        <span />
        <span />
        <span />
      </span>
      <ThinkingLabel isQueued={isQueued} rotatingLabel={rotatingLabel} />
    </div>
  );
}

function FinishedRunRow({
  thread,
  label,
  source,
}: {
  thread: ChatThreadSignals;
  label: string;
  source: RecommendedFollowupSource | null;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-5 flex-col justify-center gap-1.5">
        <div className="h-px w-full bg-border/40" />
        <div className="flex items-center gap-2">
          <p className="text-[11px] italic text-muted-foreground/40 font-serif shrink-0">
            {label}
          </p>
          <div className="h-px flex-1 bg-border/40" />
        </div>
      </div>
      {source ? (
        <RecommendedFollowupList thread={thread} source={source} />
      ) : null}
    </div>
  );
}

function WaitingForAssistantResponse({
  thread,
  blockStyle,
  isQueued,
  rotatingLabel,
}: {
  thread: ChatThreadSignals;
  blockStyle: CSSProperties;
  isQueued: boolean;
  rotatingLabel: string;
}) {
  return (
    <div
      data-thinking-indicator
      data-role="assistant"
      className="flex flex-col gap-1 animate-in fade-in slide-in-from-bottom-2 duration-300"
    >
      <div className="flex flex-col gap-2 @[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
        <AssistantBubbleAvatar thread={thread} />
        <div className="zero-chat-bubble-assistant rounded-xl py-4 text-sm leading-relaxed min-w-0 overflow-hidden">
          <div className="flex items-center gap-2 min-w-0">
            <span className="zero-blocks shrink-0" style={blockStyle}>
              <span />
              <span />
              <span />
            </span>
            <ThinkingLabel isQueued={isQueued} rotatingLabel={rotatingLabel} />
          </div>
        </div>
      </div>
      <div
        aria-hidden
        className="@[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px]"
      >
        <div className="hidden @[900px]:block" />
        <div className="flex items-center py-2 gap-1 -ml-1" />
      </div>
    </div>
  );
}

function ThinkingIndicator({
  thread,
  groups,
}: {
  thread: ChatThreadSignals;
  groups: GroupedChatMessageGroup[];
}) {
  const allFinishedLoadable = useLastLoadable(thread.allFinished$);
  const allFinishedResolved = allFinishedLoadable.state === "hasData";
  const allFinished = allFinishedResolved ? allFinishedLoadable.data : false;
  const [c1, c2, c3] = useGet(thread.blockColors$);
  const blockStyle = {
    "--zb-c1": c1,
    "--zb-c2": c2,
    "--zb-c3": c3,
  } as CSSProperties;

  const lastGroup = groups[groups.length - 1];
  const lastIsAssistant = lastGroup?.role === "assistant";
  const lastAssistantMessage =
    lastIsAssistant && lastGroup
      ? lastGroup.messages[lastGroup.messages.length - 1]
      : undefined;
  const lastAssistantCancelled =
    isCancelledAssistantMessage(lastAssistantMessage);
  const runActive =
    allFinishedResolved && !allFinished && !lastAssistantCancelled;
  const waitingForAssistant =
    lastGroup?.role === "user" &&
    lastGroup.messages.length > 0 &&
    (!allFinishedResolved ||
      lastGroup.messages.some((message) => {
        return message.isOptimisticRun || message.runId !== undefined;
      }));
  const running = runActive || waitingForAssistant;
  const rotatingLabel = useGet(thread.rotatingPhrase$);
  const donePhrase = useGet(thread.donePhrase$);
  const latestRunStatus = useLastResolved(thread.latestRunStatus$);
  const isQueued = latestRunStatus === "queued";
  const features = useLastResolved(featureSwitch$);
  const recommendedFollowupsEnabled =
    features?.[FeatureSwitchKey.ChatRecommendedFollowups] ?? false;
  const recommendedFollowupSource = recommendedFollowupsEnabled
    ? latestRecommendedFollowups(groups)
    : null;
  const doneLabel = recommendedFollowupSource
    ? "Recommended follow-ups"
    : donePhrase;

  if (
    !shouldRenderThinkingIndicator({
      lastGroup,
      lastIsAssistant,
      running,
      lastAssistantCancelled,
    })
  ) {
    return null;
  }

  // Shared inline row with fixed h-5 to prevent layout jump on transition
  if (lastIsAssistant || !running) {
    return (
      <div
        data-thinking-indicator
        data-role="assistant-thinking"
        className="-mt-5 @[900px]:grid @[900px]:grid-cols-[36px_1fr] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start"
      >
        <div className="hidden @[900px]:block" />
        <div className="min-w-0">
          {running ? (
            <InlineThinkingRow
              blockStyle={blockStyle}
              isQueued={isQueued}
              rotatingLabel={rotatingLabel}
            />
          ) : (
            <FinishedRunRow
              thread={thread}
              label={doneLabel}
              source={recommendedFollowupSource}
            />
          )}
        </div>
      </div>
    );
  }

  // Waiting for first assistant response — show bubble with avatar
  return (
    <WaitingForAssistantResponse
      thread={thread}
      blockStyle={blockStyle}
      isQueued={isQueued}
      rotatingLabel={rotatingLabel}
    />
  );
}

/**
 * Parse inline attachment lines from message content.
 * Matches `[Attached file: name](url)` optionally followed by a curl line.
 * Returns the cleaned content and parsed attachments.
 */
function parseInlineAttachments(content: string): {
  cleanContent: string;
  parsed: { filename: string; url: string }[];
} {
  const parsed: { filename: string; url: string }[] = [];
  const cleaned = content.replace(
    /\[Attached file: ([^\]]+)\]\(([^)]+)\)(?:\nDownload with: curl [^\n]*)?\n?/g,
    (_match, filename: string, url: string) => {
      parsed.push({ filename, url });
      return "";
    },
  );
  return { cleanContent: cleaned.trim(), parsed };
}

function BodyContentBlocks({
  blocks,
  openLightbox,
  hardBreaks,
}: {
  blocks: BodyRenderBlock[];
  openLightbox: (url: string) => void;
  hardBreaks: boolean;
}) {
  const openVideoLightbox = useSet(openAttachmentVideoLightbox$);

  return (
    <div className="flex flex-col gap-3">
      {blocks.map((block) => {
        if (block.type === "markdown") {
          return (
            <Markdown
              key={block.id}
              source={
                hardBreaks
                  ? block.content.replace(/\n/g, "  \n")
                  : block.content
              }
              mediaPreview
              mathEnabled
            />
          );
        }

        if (block.type === "connector-action") {
          return <ConnectorActionCard key={block.id} block={block} />;
        }

        if (block.type === "permission-action") {
          return <PermissionActionCard key={block.id} block={block} />;
        }

        if (block.preview.kind === "image") {
          return (
            <ChatImagePreviewLink
              key={block.id}
              alt={block.preview.filename}
              ariaLabel={`Preview ${block.preview.filename}`}
              imageClassName="max-h-48 max-w-full object-contain"
              linkClassName="w-fit max-w-full rounded-lg border border-foreground/10"
              onPreview={() => {
                openLightbox(block.preview.url);
              }}
              placeholderClassName="h-48 w-64 max-w-full"
              url={block.preview.url}
            />
          );
        }

        if (block.preview.kind === "video") {
          return (
            <ChatVideoPreviewButton
              key={block.id}
              ariaLabel={`Preview ${block.preview.filename}`}
              buttonClassName="w-fit max-w-full rounded-lg border border-foreground/10"
              filename={block.preview.filename}
              onPreview={() => {
                openVideoLightbox({
                  url: block.preview.url,
                  filename: block.preview.filename,
                });
              }}
              posterClassName="h-48 w-64 max-w-full"
              url={block.preview.url}
              videoClassName="h-full w-full object-contain"
            />
          );
        }

        return (
          <AttachmentPreview
            key={block.id}
            attachment={{
              filename: block.preview.filename,
              url: block.preview.url,
              contentType: contentTypeForBodyPreviewKind(block.preview.kind),
            }}
            text$={block.preview.text$}
          />
        );
      })}
    </div>
  );
}

function ConnectorActionCard({ block }: { block: ConnectorActionBlock }) {
  const pageSignal = useGet(pageSignal$);
  const available = useLastResolved(block.available$) ?? false;
  const complete = useLastResolved(block.complete$) ?? false;
  const [activateLoadable, activate] = useLoadableSet(block.activate$);
  const activating = activateLoadable.state === "loading";
  const config = CONNECTOR_TYPES[block.connectorType];

  if (!available) {
    return null;
  }

  return (
    <div
      data-testid="connector-action-card"
      className="flex min-h-[88px] w-full flex-col gap-3 rounded-lg border border-border/70 bg-background/85 p-3 text-left shadow-sm sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/40">
          <ConnectorIcon type={block.connectorType} size={22} />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">
            {config.label}
          </div>
          <div className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
            {config.helpText}
          </div>
        </div>
      </div>
      <button
        type="button"
        disabled={complete || activating}
        onClick={() => {
          detach(activate(pageSignal), Reason.DomCallback);
        }}
        className="inline-flex h-9 w-full shrink-0 items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
      >
        {activating && <IconLoader2 size={15} className="animate-spin" />}
        {complete ? "Connected" : "Connect"}
      </button>
    </div>
  );
}

interface PermissionActionButtonState {
  hasAgent: boolean;
  hasPermission: boolean;
  loading: boolean;
  loadError: boolean;
  saving: boolean;
  saveDone: boolean;
  alreadyApplied: boolean;
}

type PermissionAction = "allow" | "deny";

type PermissionActionUserGrant = UserPermissionGrantResponse;

interface LoadableLike<T> {
  state: string;
  data?: T;
}

type UpsertUserPermissionGrantFn = (
  params: {
    agentId: string;
    connectorRef: string;
    permission: string;
    action: PermissionAction;
  },
  signal: AbortSignal,
) => Promise<void>;

function loadableData<T>(loadable: LoadableLike<T>): T | undefined {
  return loadable.state === "hasData" ? loadable.data : undefined;
}

function permissionActionVerb(action: PermissionAction): string {
  return action === "allow" ? "Allow" : "Deny";
}

function permissionActionButtonLabel(
  state: PermissionActionButtonState,
): string {
  if (state.loading) {
    return "Checking permissions";
  }
  if (state.loadError) {
    return "Failed to load permissions";
  }
  if (!state.hasPermission) {
    return "Unknown permission";
  }
  if (state.saving) {
    return "Saving...";
  }
  return "Confirm";
}

function permissionActionButtonDisabled(
  state: PermissionActionButtonState,
): boolean {
  return (
    state.loading ||
    state.loadError ||
    state.saving ||
    !state.hasAgent ||
    !state.hasPermission
  );
}

function permissionActionStatusText(
  state: PermissionActionButtonState,
  action: "allow" | "deny",
): { label: string; className: string } | null {
  if (state.saveDone || state.alreadyApplied) {
    return action === "allow"
      ? { label: "Permissions updated", className: "text-green-600" }
      : { label: "Permission denied", className: "text-destructive" };
  }
  return null;
}

function PermissionActionButton({
  state,
  action,
  onClick,
}: {
  state: PermissionActionButtonState;
  action: "allow" | "deny";
  onClick: () => void;
}) {
  const status = permissionActionStatusText(state, action);
  if (status) {
    return (
      <span className={`shrink-0 text-sm font-medium ${status.className}`}>
        {status.label}
      </span>
    );
  }

  return (
    <button
      type="button"
      disabled={permissionActionButtonDisabled(state)}
      onClick={onClick}
      className="inline-flex h-9 w-full shrink-0 items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent sm:w-auto"
    >
      {state.saving && <IconLoader2 size={15} className="animate-spin" />}
      {permissionActionButtonLabel(state)}
    </button>
  );
}

function isPermissionActionLoading(params: {
  agentLoading: boolean;
  userGrantsLoading: boolean;
}): boolean {
  return params.agentLoading || params.userGrantsLoading;
}

function isPermissionActionSaving(params: { grantLoading: boolean }): boolean {
  return params.grantLoading;
}

function isPermissionActionLoadError(params: {
  agentError: boolean;
  userGrantsError: boolean;
}): boolean {
  return params.agentError || params.userGrantsError;
}

function isPermissionActionAlreadyApplied(params: {
  hasAgent: boolean;
  userGrantPolicy: FirewallPolicyValue | undefined;
  action: "allow" | "deny";
}): boolean {
  if (!params.hasAgent) {
    return false;
  }
  return params.userGrantPolicy === params.action;
}

function findPermissionActionPermission(block: PermissionActionBlock) {
  return extractPermissions(block.connectorRef).find((permission) => {
    return permission.name === block.permission;
  });
}

function permissionActionUserGrantPolicy(
  loadable: LoadableLike<readonly PermissionActionUserGrant[]>,
  block: PermissionActionBlock,
): FirewallPolicyValue | undefined {
  const grants = loadableData(loadable);
  if (!grants) {
    return undefined;
  }
  return resolveUserPermissionGrantPolicy(
    grants,
    block.connectorRef,
    block.permission,
  );
}

function createPermissionActionButtonState(params: {
  hasAgent: boolean;
  hasPermission: boolean;
  loading: boolean;
  loadError: boolean;
  saving: boolean;
  alreadyApplied: boolean;
  saveDone: boolean;
}): PermissionActionButtonState {
  return {
    hasAgent: params.hasAgent,
    hasPermission: params.hasPermission,
    loading: params.loading,
    loadError: params.loadError,
    saving: params.saving,
    saveDone: params.saveDone,
    alreadyApplied: params.alreadyApplied,
  };
}

function createPermissionActionCardButtonState(params: {
  hasAgent: boolean;
  focusedPermission: { name: string } | undefined;
  loading: boolean;
  loadError: boolean;
  saving: boolean;
  saveDone: boolean;
  alreadyApplied: boolean;
}): PermissionActionButtonState {
  return createPermissionActionButtonState({
    hasAgent: params.hasAgent,
    hasPermission: Boolean(params.focusedPermission),
    loading: params.loading,
    loadError: params.loadError,
    saving: params.saving,
    saveDone: params.saveDone,
    alreadyApplied: params.alreadyApplied,
  });
}

function createPermissionActionCardViewState(params: {
  block: PermissionActionBlock;
  hasAgent: boolean;
  agentLoadableState: string;
  userGrantsLoadable: LoadableLike<readonly PermissionActionUserGrant[]>;
  grantLoadableState: string;
}) {
  const focusedPermission = findPermissionActionPermission(params.block);
  const actionLabel = permissionActionVerb(params.block.action);
  const loading = isPermissionActionLoading({
    agentLoading: params.agentLoadableState === "loading",
    userGrantsLoading: params.userGrantsLoadable.state === "loading",
  });
  const loadError = isPermissionActionLoadError({
    agentError: params.agentLoadableState === "hasError",
    userGrantsError: params.userGrantsLoadable.state === "hasError",
  });
  const saving = isPermissionActionSaving({
    grantLoading: params.grantLoadableState === "loading",
  });
  const userGrantPolicy = permissionActionUserGrantPolicy(
    params.userGrantsLoadable,
    params.block,
  );
  const alreadyApplied = isPermissionActionAlreadyApplied({
    hasAgent: params.hasAgent,
    userGrantPolicy,
    action: params.block.action,
  });
  const saveDone = params.grantLoadableState === "hasData";
  const buttonState = createPermissionActionCardButtonState({
    hasAgent: params.hasAgent,
    focusedPermission,
    loading,
    loadError,
    saving,
    saveDone,
    alreadyApplied,
  });
  return {
    actionLabel,
    buttonState,
    focusedPermission,
    finished: saveDone,
  };
}

function runPermissionAction(params: {
  hasAgent: boolean;
  focusedPermission: { name: string } | undefined;
  state: PermissionActionButtonState;
  finished: boolean;
  runUserGrant: () => void;
}): void {
  if (
    !params.hasAgent ||
    !params.focusedPermission ||
    params.state.loading ||
    params.state.loadError ||
    params.state.saving ||
    params.state.alreadyApplied ||
    params.finished
  ) {
    return;
  }

  params.runUserGrant();
}

function createPermissionActionHandler(params: {
  block: PermissionActionBlock;
  pageSignal: AbortSignal;
  hasAgent: boolean;
  focusedPermission: { name: string } | undefined;
  state: PermissionActionButtonState;
  finished: boolean;
  upsertGrant: UpsertUserPermissionGrantFn;
}): () => void {
  return () => {
    const permissionName =
      params.focusedPermission?.name ?? params.block.permission;
    runPermissionAction({
      hasAgent: params.hasAgent,
      focusedPermission: params.focusedPermission,
      state: params.state,
      finished: params.finished,
      runUserGrant: () => {
        detach(
          params.upsertGrant(
            {
              agentId: params.block.agentId,
              connectorRef: params.block.connectorRef,
              permission: permissionName,
              action: params.block.action,
            },
            params.pageSignal,
          ),
          Reason.DomCallback,
        );
      },
    });
  };
}

function PermissionActionCardContent({
  block,
  connectorLabel,
  actionLabel,
  permissionName,
  buttonState,
  onClick,
}: {
  block: PermissionActionBlock;
  connectorLabel: string;
  actionLabel: string;
  permissionName: string;
  buttonState: PermissionActionButtonState;
  onClick: () => void;
}) {
  return (
    <div
      data-testid="permission-action-card"
      className="flex min-h-[88px] w-full flex-col gap-3 rounded-lg border border-border/70 bg-background/85 p-3 text-left shadow-sm sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/40">
          <ConnectorIcon type={block.connectorRef} size={22} />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">
            {connectorLabel} permissions
          </div>
          <div className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
            {actionLabel} {permissionName}
          </div>
        </div>
      </div>
      <PermissionActionButton
        state={buttonState}
        action={block.action}
        onClick={onClick}
      />
    </div>
  );
}

function PermissionActionCard({ block }: { block: PermissionActionBlock }) {
  const pageSignal = useGet(pageSignal$);
  const config = CONNECTOR_TYPES[block.connectorRef];
  const agentLoadable = useLastLoadable(agentById(block.agentId));
  const [grantLoadable, upsertGrant] = useLoadableSet(
    upsertUserPermissionGrant$,
  );
  const userGrantsLoadable = useLoadable(
    userPermissionGrantsByAgent({
      agentId: block.agentId,
    }),
  );
  const hasAgent =
    agentLoadable.state === "hasData" && Boolean(agentLoadable.data);
  const actionState = createPermissionActionCardViewState({
    block,
    hasAgent,
    agentLoadableState: agentLoadable.state,
    userGrantsLoadable,
    grantLoadableState: grantLoadable.state,
  });

  return (
    <PermissionActionCardContent
      block={block}
      connectorLabel={config.label}
      actionLabel={actionState.actionLabel}
      permissionName={actionState.focusedPermission?.name ?? block.permission}
      buttonState={actionState.buttonState}
      onClick={createPermissionActionHandler({
        block,
        pageSignal,
        hasAgent,
        focusedPermission: actionState.focusedPermission,
        state: actionState.buttonState,
        finished: actionState.finished,
        upsertGrant,
      })}
    />
  );
}

function ChatConnectorActionConnectModal() {
  const active = useGet(activeChatConnectorAction$);
  const close = useSet(closeChatConnectorActionConnectDialog$);
  const [, complete] = useLoadableSet(completeChatConnectorActionConnect$);
  const pageSignal = useGet(pageSignal$);

  if (!active) {
    return null;
  }

  return (
    <ConnectModal
      onClose={close}
      onSuccess={() => {
        return complete(pageSignal);
      }}
    />
  );
}

function isImageFilename(filename: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|avif|heic|heif|tiff?|psd)$/i.test(
    filename,
  );
}

const CREDITS_PER_DOLLAR = 1000;
const CREDIT_TOP_UP_OPTIONS = [100_000, 200_000, 300_000] as const;

function formatCreditsUsd(credits: number): string {
  const dollars = credits / CREDITS_PER_DOLLAR;
  return dollars.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: Number.isInteger(dollars) ? 0 : 2,
  });
}

function customCreditsFromForm(form: HTMLFormElement | null): number | null {
  const element = form?.elements.namedItem("customUsd");
  if (!(element instanceof HTMLInputElement)) {
    return null;
  }

  const usd = Number(element.value);
  const credits = usd * CREDITS_PER_DOLLAR;
  if (!Number.isInteger(credits) || credits < 1000 || credits > 10_000_000) {
    return null;
  }
  return credits;
}

function CreditsAvailableMessage() {
  return (
    <div className="max-w-md">
      <p className="text-sm font-medium text-emerald-700 dark:text-emerald-300">
        Credits available
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Your credits have been added. You can continue chatting with Zero.
      </p>
    </div>
  );
}

function insufficientCreditsCopy(params: {
  readonly isFree: boolean;
  readonly requiresPro: boolean;
  readonly roleResolved: boolean;
  readonly canManageBilling: boolean;
}): { readonly headline: string; readonly helper: string } {
  const headline = params.requiresPro
    ? "Upgrade to Pro to run Zero"
    : params.isFree
      ? "You've used your free credits"
      : "You're out of credits";
  if (!params.roleResolved) {
    return { headline, helper: "Checking billing permissions..." };
  }
  if (!params.canManageBilling) {
    return {
      headline,
      helper:
        params.requiresPro || params.isFree
          ? "Ask a workspace admin to upgrade to Pro so you can keep chatting with Zero."
          : "Ask a workspace admin to add credits so you can keep chatting with Zero.",
    };
  }
  return {
    headline,
    helper:
      params.requiresPro || params.isFree
        ? "Upgrade to Pro to keep chatting with Zero."
        : "Add credits to keep chatting with Zero.",
  };
}

function PaidCreditCheckoutActions({
  redirecting,
  handleCreditClick,
}: {
  readonly redirecting: boolean;
  readonly handleCreditClick: (
    selection: CreditCheckoutSelection,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => void;
}) {
  const handleCustomCreditClick = (
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => {
    const credits = customCreditsFromForm(event.currentTarget.form);
    if (credits === null) {
      toast.error("Enter between $1 and $10,000");
      return;
    }
    handleCreditClick({ credits, customAmount: true }, event);
  };

  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {CREDIT_TOP_UP_OPTIONS.map((credits) => {
          return (
            <button
              key={credits}
              type="button"
              onClick={(event) => {
                handleCreditClick({ credits }, event);
              }}
              disabled={redirecting}
              className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
            >
              {formatCreditsUsd(credits)}
            </button>
          );
        })}
        <details>
          <summary
            role="button"
            className="inline-flex h-8 cursor-pointer list-none items-center rounded-md border border-border bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent marker:hidden disabled:opacity-60 [&::-webkit-details-marker]:hidden"
          >
            Custom
          </summary>
          <form className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">$</span>
            <input
              type="text"
              inputMode="numeric"
              name="customUsd"
              defaultValue="100"
              onInput={(event) => {
                event.currentTarget.value = event.currentTarget.value.replace(
                  /\D/g,
                  "",
                );
              }}
              aria-label="Custom dollar amount"
              className="h-8 w-24 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none transition-colors focus:border-ring"
            />
            <button
              type="button"
              onClick={handleCustomCreditClick}
              disabled={redirecting}
              className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
            >
              {redirecting ? "Redirecting..." : "Buy"}
            </button>
          </form>
        </details>
      </div>
    </div>
  );
}

function InsufficientCreditsCard() {
  const billingLoadable = useLoadable(billingStatusAsync$);
  const [checkoutLoadable, checkout] = useLoadableSet(startCheckout$);
  const [creditCheckoutLoadable, creditCheckout] =
    useLoadableSet(startCreditCheckout$);
  const setOrgManageOpen = useSet(setOrgManageDialogOpen$);
  const setTab = useSet(setActiveOrgManageTab$);
  const setSubPage = useSet(setBillingSubPage$);
  const pageSignal = useGet(pageSignal$);

  const tier =
    billingLoadable.state === "hasData" ? billingLoadable.data.tier : null;
  const credits =
    billingLoadable.state === "hasData" ? billingLoadable.data.credits : null;
  const isAdminLoadable = useLastLoadable(isOrgAdmin$);
  const roleResolved = isAdminLoadable.state === "hasData";
  const canManageBilling = roleResolved ? isAdminLoadable.data : false;
  const requiresPro = tier === "pro-suspend";
  const hasAvailableCredits = !requiresPro && credits !== null && credits > 0;
  const isFree = tier === "free" || tier === null;
  const shouldStartProCheckout = requiresPro || isFree;
  const redirecting =
    checkoutLoadable.state === "loading" ||
    creditCheckoutLoadable.state === "loading";

  if (hasAvailableCredits) {
    return <CreditsAvailableMessage />;
  }

  const { headline, helper } = insufficientCreditsCopy({
    isFree,
    requiresPro,
    roleResolved,
    canManageBilling,
  });

  const openBilling = () => {
    setTab("billing");
    setSubPage(false);
    detach(setOrgManageOpen(true, pageSignal), Reason.DomCallback);
  };

  const handleUpgradeClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (shouldStartProCheckout) {
      const newTab = event.metaKey || event.ctrlKey;
      detach(
        checkout("pro", newTab, undefined, pageSignal),
        Reason.DomCallback,
      );
      return;
    }
    openBilling();
  };

  const handleCreditClick = (
    selection: CreditCheckoutSelection,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => {
    const newTab = event.metaKey || event.ctrlKey;
    detach(creditCheckout(selection, newTab, pageSignal), Reason.DomCallback);
  };

  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-3 max-w-md">
      <p className="text-sm font-medium text-foreground">{headline}</p>
      <p className="mt-1 text-xs text-muted-foreground">{helper}</p>
      {!canManageBilling ? null : shouldStartProCheckout ? (
        <button
          type="button"
          onClick={handleUpgradeClick}
          disabled={redirecting}
          className="mt-3 inline-flex h-8 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
        >
          {redirecting ? "Redirecting..." : "Upgrade to Pro"}
        </button>
      ) : (
        <PaidCreditCheckoutActions
          redirecting={redirecting}
          handleCreditClick={handleCreditClick}
        />
      )}
    </div>
  );
}

function AssistantErrorContent({ error }: { error: string }) {
  const setOrgManageOpen = useSet(setOrgManageDialogOpen$);
  const setTab = useSet(setActiveOrgManageTab$);
  const pageSignal = useGet(pageSignal$);

  if (error === "insufficient_credits") {
    return <InsufficientCreditsCard />;
  }

  if (error.trim().toLowerCase() === "run cancelled") {
    return (
      <div
        className="inline-flex items-center gap-2 bg-muted/50 px-3 py-1.5 text-[13px] text-muted-foreground"
        style={{
          border: "0.7px solid hsl(var(--border))",
          borderRadius: "12px",
        }}
      >
        <IconHandStop size={14} stroke={1.75} className="shrink-0" />
        <span>Paused mid-thought — pick it back up whenever.</span>
      </div>
    );
  }

  const noProviderGuidance = RUN_ERROR_GUIDANCE.NO_MODEL_PROVIDER;
  const isNoModelProvider =
    noProviderGuidance !== undefined &&
    error.toLowerCase().includes(noProviderGuidance.title.toLowerCase());

  if (isNoModelProvider) {
    return (
      <div className="flex items-start gap-2 text-foreground">
        <IconAlertCircle
          size={16}
          className="shrink-0 mt-[3px] text-amber-500"
        />
        <span>
          No model provider configured yet.{" "}
          <button
            type="button"
            className="inline-flex items-center gap-1 text-amber-500 underline underline-offset-2 hover:text-amber-400"
            onClick={() => {
              setTab("providers");
              detach(setOrgManageOpen(true, pageSignal), Reason.DomCallback);
            }}
          >
            Set one up in Workspace Settings
          </button>{" "}
          to get started.
        </span>
      </div>
    );
  }

  const incompatibleGuidance = RUN_ERROR_GUIDANCE.PROVIDER_INCOMPATIBLE;
  const isProviderIncompatible =
    (incompatibleGuidance !== undefined &&
      error.toLowerCase().includes(incompatibleGuidance.title.toLowerCase())) ||
    error.includes("Cannot continue session") ||
    error.includes("Invalid signature in thinking block");

  if (isProviderIncompatible) {
    return (
      <div className="flex items-start gap-2 text-foreground">
        <IconAlertCircle
          size={16}
          className="shrink-0 mt-[3px] text-amber-500"
        />
        <span>
          This session was started with a different model provider and
          can&apos;t be continued with the current one.{" "}
          <Link
            pathname="/"
            className="inline-flex items-center gap-1 text-amber-500 underline underline-offset-2 hover:text-amber-400"
          >
            Start a new session
          </Link>
        </span>
      </div>
    );
  }

  const deletedGuidance = RUN_ERROR_GUIDANCE.PROVIDER_DELETED;
  const isProviderDeleted =
    deletedGuidance !== undefined &&
    (error.toLowerCase().includes(deletedGuidance.title.toLowerCase()) ||
      error.toLowerCase().includes(deletedGuidance.guidance.toLowerCase()));

  if (isProviderDeleted) {
    return (
      <div className="flex items-start gap-2 text-foreground">
        <IconAlertCircle
          size={16}
          className="shrink-0 mt-[3px] text-amber-500"
        />
        <span>
          The model provider used by this thread has been deleted.{" "}
          <Link
            pathname="/"
            className="inline-flex items-center gap-1 text-amber-500 underline underline-offset-2 hover:text-amber-400"
          >
            Start a new chat thread
          </Link>{" "}
          to continue.
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2 text-destructive">
      <IconAlertCircle size={16} className="shrink-0 mt-[3px]" />
      <Markdown source={error} />
    </div>
  );
}

function AssistantBubbleAvatar({ thread }: { thread: ChatThreadSignals }) {
  const agentId = useLastResolved(thread.agentId$) ?? "";
  return (
    <Link
      pathname="/agents/:agentId"
      options={{ pathParams: { agentId } }}
      className="h-7 w-7 @[900px]:h-9 @[900px]:w-9 shrink-0 @[900px]:mt-0.5 overflow-hidden rounded-xl transition-colors duration-150 hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      aria-label="View agent profile"
    >
      <AgentAvatarImg
        name={agentId}
        alt=""
        className="h-7 w-7 @[900px]:h-9 @[900px]:w-9 rounded-full object-cover object-top"
      />
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Paged message rendering — renders from groupedChatMessages$ (flat data,
// no signal-based run loops).
// ---------------------------------------------------------------------------

function PagedGroupRow({
  group,
  thread,
}: {
  group: GroupedChatMessageGroup;
  thread: ChatThreadSignals;
}) {
  if (group.role === "user") {
    return <PagedUserGroup group={group} thread={thread} />;
  }
  return <PagedAssistantGroup group={group} thread={thread} />;
}

function PagedUserGroup({
  group,
  thread,
}: {
  group: GroupedChatMessageGroup;
  thread: ChatThreadSignals;
}) {
  return (
    <>
      {group.messages.map((msg) => {
        return <PagedUserMessage key={msg.id} message={msg} thread={thread} />;
      })}
    </>
  );
}

function resolveAttachments(
  message: PagedChatMessage,
  parsed: { filename: string; url: string }[],
) {
  const source =
    message.attachFiles && message.attachFiles.length > 0
      ? message.attachFiles
      : parsed;
  return source.map((f) => {
    const contentType =
      "contentType" in f && typeof f.contentType === "string"
        ? f.contentType
        : undefined;
    const kind = classifyChatAttachment({
      filename: f.filename,
      url: f.url,
      contentType,
    });
    return {
      filename: f.filename,
      url: f.url,
      contentType,
      isImage: kind === "image" || isImageFilename(f.filename),
      kind,
    };
  });
}

function attachmentIdFromUrl(url: string): string | null {
  if (!URL.canParse(url, window.location.origin)) {
    return null;
  }
  const parsed = new URL(url, window.location.origin);
  const match = parsed.pathname.match(/^\/f\/[^/]+\/([^/]+)\/[^/]+$/);
  return match?.[1] ?? null;
}

function inferAttachmentContentType(filename: string, kind: string): string {
  const contentTypesByExtension: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    avif: "image/avif",
    heic: "image/heic",
    heif: "image/heif",
    tif: "image/tiff",
    tiff: "image/tiff",
    psd: "image/vnd.adobe.photoshop",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    mp3: "audio/mpeg",
    mpga: "audio/mpeg",
    wav: "audio/wav",
    wave: "audio/wave",
    m4a: "audio/mp4",
    aac: "audio/aac",
    ogg: "audio/ogg",
    oga: "audio/ogg",
    opus: "audio/opus",
    flac: "audio/flac",
    pdf: "application/pdf",
    txt: "text/plain",
    log: "text/plain",
    csv: "text/csv",
    md: "text/markdown",
    html: "text/html",
    htm: "text/html",
    json: "application/json",
    xml: "application/xml",
    yaml: "application/yaml",
    yml: "application/yaml",
    tsv: "text/tab-separated-values",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    docm: "application/vnd.ms-word.document.macroenabled.12",
    dotm: "application/vnd.ms-word.template.macroenabled.12",
    dotx: "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
    odt: "application/vnd.oasis.opendocument.text",
    rtf: "application/rtf",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xlsb: "application/vnd.ms-excel.sheet.binary.macroenabled.12",
    xlsm: "application/vnd.ms-excel.sheet.macroenabled.12",
    xltm: "application/vnd.ms-excel.template.macroenabled.12",
    xltx: "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
    ods: "application/vnd.oasis.opendocument.spreadsheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    potm: "application/vnd.ms-powerpoint.template.macroenabled.12",
    potx: "application/vnd.openxmlformats-officedocument.presentationml.template",
    odp: "application/vnd.oasis.opendocument.presentation",
    ppsx: "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
    ppsm: "application/vnd.ms-powerpoint.slideshow.macroenabled.12",
    pptm: "application/vnd.ms-powerpoint.presentation.macroenabled.12",
    zip: "application/zip",
    rar: "application/vnd.rar",
    "7z": "application/x-7z-compressed",
    tar: "application/x-tar",
    gz: "application/gzip",
    tgz: "application/gzip",
    bz2: "application/x-bzip2",
    xz: "application/x-xz",
    pages: "application/vnd.apple.pages",
    numbers: "application/vnd.apple.numbers",
    key: "application/vnd.apple.keynote",
    parquet: "application/vnd.apache.parquet",
    sqlite: "application/vnd.sqlite3",
    sqlite3: "application/vnd.sqlite3",
    db: "application/vnd.sqlite3",
    epub: "application/epub+zip",
    ai: "application/postscript",
  };
  const lower = filename.toLowerCase();
  const extension = lower.includes(".") ? lower.split(".").pop() : undefined;
  const contentType =
    extension === undefined ? undefined : contentTypesByExtension[extension];
  if (contentType !== undefined) {
    return contentType;
  }
  switch (kind) {
    case "markdown": {
      return "text/markdown";
    }
    case "text": {
      return "text/plain";
    }
    case "json": {
      return "application/json";
    }
    case "csv": {
      return "text/csv";
    }
    case "pdf": {
      return "application/pdf";
    }
    case "html": {
      return "text/html";
    }
    default: {
      return "application/octet-stream";
    }
  }
}

function clipboardAttachmentsFromMessage(
  message: PagedChatMessage,
  parsed: { filename: string; url: string }[],
): ChatClipboardAttachment[] {
  const source =
    message.attachFiles && message.attachFiles.length > 0
      ? message.attachFiles
      : parsed;
  return source.map((f) => {
    const contentType =
      "contentType" in f && typeof f.contentType === "string"
        ? f.contentType
        : undefined;
    const kind = classifyChatAttachment({
      filename: f.filename,
      url: f.url,
      contentType,
    });
    return {
      id:
        "id" in f && typeof f.id === "string"
          ? f.id
          : attachmentIdFromUrl(f.url),
      filename: f.filename,
      url: f.url,
      contentType: contentType ?? inferAttachmentContentType(f.filename, kind),
      size: "size" in f && typeof f.size === "number" ? f.size : 0,
    };
  });
}

function UserMessageAttachments({
  attachments,
  onImageClick,
}: {
  attachments: ReturnType<typeof resolveAttachments>;
  onImageClick: (url: string) => void;
}) {
  const openVideoLightbox = useSet(openAttachmentVideoLightbox$);

  if (attachments.length === 0) {
    return null;
  }

  return (
    <div className="border-t border-foreground/10 px-3 py-2.5 flex flex-wrap gap-2">
      {attachments.map((a) => {
        if (a.isImage) {
          return (
            <ChatImagePreviewLink
              key={a.url}
              alt={a.filename}
              ariaLabel={`Preview ${a.filename}`}
              imageClassName="h-9 max-w-[72px] object-cover"
              linkClassName="rounded-lg border border-foreground/10 transition-colors hover:border-foreground/25"
              onPreview={() => {
                onImageClick(a.url);
              }}
              placeholderClassName="h-9 w-[72px]"
              url={a.url}
            />
          );
        }
        if (a.kind === "video") {
          return (
            <ChatVideoPreviewButton
              key={a.url}
              ariaLabel={`Preview ${a.filename}`}
              buttonClassName="rounded-lg border border-foreground/10 transition-colors hover:border-foreground/25"
              filename={a.filename}
              onPreview={() => {
                openVideoLightbox({
                  url: a.url,
                  filename: a.filename,
                });
              }}
              posterClassName="h-9 w-[72px]"
              url={a.url}
              videoClassName="h-full w-full object-cover"
            />
          );
        }
        if (
          a.kind === "markdown" ||
          a.kind === "text" ||
          a.kind === "json" ||
          a.kind === "csv" ||
          a.kind === "pdf" ||
          a.kind === "html"
        ) {
          return (
            <PreviewableFileAttachmentChip
              key={a.url}
              filename={a.filename}
              url={a.url}
              kind={a.kind}
            />
          );
        }
        return (
          <FileAttachmentChip
            key={a.url}
            filename={a.filename}
            url={a.url}
            contentType={a.contentType}
          />
        );
      })}
    </div>
  );
}

function UserMessageActions({
  canCopy,
  copied,
  onCopy,
}: {
  canCopy: boolean;
  copied: boolean;
  onCopy: () => void;
}) {
  if (!canCopy) {
    return null;
  }
  return (
    <div className="flex justify-end gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
      <button
        type="button"
        onClick={onCopy}
        className="p-1 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-accent transition-colors duration-150"
        aria-label="Copy message"
      >
        {copied ? (
          <IconCheck size={18} stroke={1.5} />
        ) : (
          <IconCopy size={18} stroke={1.5} />
        )}
      </button>
    </div>
  );
}

function PagedUserMessage({
  message,
  thread,
}: {
  message: EnrichedChatMessage;
  thread: ChatThreadSignals;
}) {
  const content = message.content ?? "";
  // Two attachment sources coexist: the structured `attachFiles` field
  // (current flow) and legacy `[Attached file: ...](url)` inline lines left
  // over from messages sent before #10243 split the flows. Use the structured
  // source when it's present and fall back to inline parsing otherwise.
  const { cleanContent, parsed } = parseInlineAttachments(content);
  // `ATTACH_ONLY_PLACEHOLDER` is the server-side placeholder stored when the
  // user sent only files with no typed text — strip it so the bubble shows
  // just the attachments.
  const strippedContent =
    message.attachFiles &&
    message.attachFiles.length > 0 &&
    cleanContent.trim() === ATTACH_ONLY_PLACEHOLDER
      ? ""
      : cleanContent;
  const bodyBlocks = enrichBlocksWithTextPreviews(
    parseBodyRenderBlocks(strippedContent, { previews: false }).blocks,
  );
  const pageSignal = useGet(pageSignal$);
  const openImageLightbox = useSet(openAttachmentImageLightbox$);
  const openLightbox = (url: string) => {
    openImageLightbox(url);
  };
  const copiedId = useGet(thread.copiedMessageId$);
  const copied = copiedId === message.id;
  const copyMessage = useSet(thread.copyMessage$);
  const allAttachments = resolveAttachments(message, parsed);
  const clipboardAttachments = clipboardAttachmentsFromMessage(message, parsed);
  const copyText = strippedContent;
  const canCopy = copyText.trim().length > 0 || clipboardAttachments.length > 0;

  const handleCopy = () => {
    if (!canCopy) {
      return;
    }
    detach(
      copyMessage(
        message.id,
        { text: copyText, attachments: clipboardAttachments },
        pageSignal,
      ),
      Reason.DomCallback,
    );
  };

  return (
    <div data-role="user" className="group">
      <div className="flex flex-col items-end min-w-0 animate-in fade-in slide-in-from-bottom-2 duration-300 @[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
        <div className="hidden @[900px]:block @[900px]:w-9 @[900px]:h-9 @[900px]:shrink-0" />
        <div className="flex flex-col items-end w-full">
          <div className="zero-chat-bubble-user rounded-xl max-w-[85%] text-sm leading-relaxed [overflow-wrap:anywhere] overflow-hidden">
            {bodyBlocks.length > 0 && (
              <div className="px-4 py-3">
                <BodyContentBlocks
                  blocks={bodyBlocks}
                  openLightbox={openLightbox}
                  hardBreaks
                />
              </div>
            )}
            <UserMessageAttachments
              attachments={allAttachments}
              onImageClick={openLightbox}
            />
          </div>
          <UserMessageActions
            canCopy={canCopy}
            copied={copied}
            onCopy={handleCopy}
          />
        </div>
      </div>
    </div>
  );
}

function PagedAssistantGroup({
  group,
  thread,
}: {
  group: GroupedChatMessageGroup;
  thread: ChatThreadSignals;
}) {
  const groupElementId = `chat-message-group-${group.beginMessageId}`;
  const fullContent = group.messages
    .map((m) => {
      return m.content;
    })
    .filter(Boolean)
    .join("\n\n");

  return (
    <div
      id={groupElementId}
      data-role="assistant"
      className="group flex flex-col gap-1 animate-in fade-in slide-in-from-bottom-2 duration-300"
    >
      <div className="flex flex-col gap-2 @[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
        <AssistantBubbleAvatar thread={thread} />
        <div className="relative flex flex-col gap-3">
          {group.messages.map((msg) => {
            return <PagedAssistantMessageItem key={msg.id} message={msg} />;
          })}
        </div>
      </div>
      <PagedGroupActions group={group} content={fullContent} thread={thread} />
    </div>
  );
}

function PagedAssistantMessageItem({
  message,
}: {
  message: EnrichedChatMessage;
}) {
  const openImageLightbox = useSet(openAttachmentImageLightbox$);
  const openLightbox = (url: string) => {
    openImageLightbox(url);
  };

  if (message.error) {
    return (
      <div className="zero-chat-bubble-assistant px-0 @[900px]:pt-2.5 text-sm leading-relaxed min-w-0 [overflow-wrap:anywhere]">
        <AssistantErrorContent error={message.error} />
      </div>
    );
  }

  if (message.content) {
    const { blocks } = message;
    return (
      <div className="zero-chat-bubble-assistant px-0 @[900px]:pt-2.5 text-sm leading-relaxed min-w-0 [overflow-wrap:anywhere]">
        {blocks.length > 0 ? (
          <BodyContentBlocks
            blocks={blocks}
            openLightbox={openLightbox}
            hardBreaks={false}
          />
        ) : null}
      </div>
    );
  }

  return null;
}

function PagedGroupPrimaryActions({
  firstRunId,
  hasContent,
  copied,
  audioOutputEnabled,
  isPlayingThis,
  onCopy,
  onTts,
}: {
  firstRunId: string | undefined;
  hasContent: boolean;
  copied: boolean;
  audioOutputEnabled: boolean;
  isPlayingThis: boolean;
  onCopy: () => void;
  onTts: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      {firstRunId && (
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                pathname="/activities/:activityRunId"
                options={{
                  pathParams: { activityRunId: firstRunId },
                }}
                className="p-1 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-accent transition-colors duration-150"
                aria-label="View run logs"
              >
                <IconChartLine size={18} stroke={1.5} />
              </Link>
            </TooltipTrigger>
            <TooltipContent side="bottom">View activity logs</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {hasContent && (
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onCopy}
                className="p-1 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-accent transition-colors duration-150"
                aria-label="Copy message"
              >
                {copied ? (
                  <IconCheck size={18} stroke={1.5} />
                ) : (
                  <IconCopy size={18} stroke={1.5} />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {copied ? "Copied!" : "Copy message"}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {hasContent && firstRunId && audioOutputEnabled && (
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onTts}
                className="p-1 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-accent transition-colors duration-150"
                aria-label={isPlayingThis ? "Stop reading" : "Read aloud"}
              >
                {isPlayingThis ? (
                  <IconPlayerStop size={18} stroke={1.5} />
                ) : (
                  <IconVolume2 size={18} stroke={1.5} />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {isPlayingThis ? "Stop reading" : "Read aloud"}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );
}

function PagedGroupActions({
  group,
  content,
  thread,
}: {
  group: GroupedChatMessageGroup;
  content: string;
  thread: ChatThreadSignals;
}) {
  const pageSignal = useGet(pageSignal$);
  const copiedId = useGet(thread.copiedMessageId$);
  const copied = copiedId === group.beginMessageId;
  const copyMessage = useSet(thread.copyMessage$);

  const features = useLastResolved(featureSwitch$);
  const audioOutputEnabled = features?.[FeatureSwitchKey.AudioOutput] ?? false;
  const firstRunId = group.messages.find((m) => {
    return m.runId;
  })?.runId;
  const hasContent = content.length > 0;
  const [ttsLoadable, playTts] = useLoadableSet(playTts$);
  const isPlayingThis = ttsLoadable.state === "loading";
  const stopTts = useSet(stopTts$);

  if (group.role === "user") {
    return null;
  }

  const handleCopy = () => {
    if (!content) {
      return;
    }
    detach(
      copyMessage(
        group.beginMessageId,
        { text: content, attachments: [] },
        pageSignal,
      ),
      Reason.DomCallback,
    );
  };

  const handleTts = () => {
    if (!firstRunId) {
      return;
    }
    if (isPlayingThis) {
      stopTts();
    } else {
      detach(playTts(content, pageSignal), Reason.DomCallback);
    }
  };

  return (
    <div className="@[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px]">
      <div className="hidden @[900px]:block" />
      <div className="flex items-center justify-between pt-2 pb-1 gap-2 -ml-1">
        <PagedGroupPrimaryActions
          firstRunId={firstRunId}
          hasContent={hasContent}
          copied={copied}
          audioOutputEnabled={audioOutputEnabled}
          isPlayingThis={isPlayingThis}
          onCopy={handleCopy}
          onTts={handleTts}
        />
      </div>
    </div>
  );
}
